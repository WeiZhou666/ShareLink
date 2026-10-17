/**
 * 文件控制器（路由前缀 /api/shares/:shareId/files）
 *
 * 路由一览（与旧后端 API 面对齐，前端 useUpload/share.service 一一对应）：
 *   POST   /               分块上传（octet-stream 原始体；创建骨架后、complete 前逐块调用）
 *   POST   /upload-init    S3 直传探测 + 签发会话（仅 s3 驱动；404 → 前端降级代理分块）
 *   POST   /upload-complete S3 直传提交（CompleteMultipartUpload + File 表登记）
 *   POST   /upload-abort   S3 直传中止（幂等）
 *   GET    /zip        打包下载（多文件 → archive.zip；单文件降级为流原文件）
 *   GET    /:fileId    下载单个文件（支持 Range 断点/拖动播放；inline/attachment 由 ?download= 控制）
 *   DELETE /:fileId    删除单个文件（编辑场景）
 *
 * 说明：
 * - 直传三端点仅 STORAGE_DRIVER=s3 时可用（StorageCapabilityError → 404）；契约对齐前端
 *   share.service 的休眠直传代码——第 0 块探测 upload-init，响应带 directToS3 即逐块 PUT
 *   预签名 URL（字节直达对象存储，不过后端），complete 收 etag 回执
 * - 路由声明顺序："zip" 必须声明在 ":fileId" 之前，否则会被通配吃掉
 * - 分块上传的原始体解析（express.raw）由 ShareModule 的中间件挂载（按 content-type 分流，
 *   JSON 体不受影响），本控制器 JSON 端点用 @Body() DTO 正常解析
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { I18nService } from 'nestjs-i18n';
import { CreateShareGuard } from './guard/create-share.guard';
import { StrictShareOwnerGuard } from './guard/share-owner.guard';
import { FileSecurityGuard } from './guard/file-security.guard';
import { FileService } from './file.service';
import { ID_PATTERN } from './share.constants';
import { buildContentDisposition } from './share.utils';
import {
  UploadAbortDTO,
  UploadCompleteDTO,
  UploadInitDTO,
} from './dto/s3-direct-upload.dto';

@Controller('shares/:shareId/files')
export class FileController {
  constructor(
    private fileService: FileService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * 分块上传（前端 useUpload 按 share.chunkSize 切片逐块 POST）
   *
   * 守卫链（与旧后端一致）：
   * - CreateShareGuard：JWT 或反向分享令牌二选一通过（匿名反向上传的入口）
   * - StrictShareOwnerGuard：创建者本人，或匿名分享（反向分享产生的分享无创建者）；
   *   管理员不能越权上传（Strict = allowAdmin=false）
   *
   * @SkipThrottle 分块请求频率极高（大文件每 chunkSize 字节一发），全局 100/分限流会误杀
   */
  @Post()
  @SkipThrottle()
  @UseGuards(CreateShareGuard, StrictShareOwnerGuard)
  async uploadChunk(
    @Req() request: Request,
    // 前端 query 传文件元信息：id 是前端生成的 uuid（分块续传要求幂等），name 是展示名
    @Query('id') id?: string,
    @Query('name') name?: string,
    @Query('chunkIndex') chunkIndex?: string,
    @Query('totalChunks') totalChunks?: string,
  ) {
    // shareId 格式前置校验（对应旧后端 IdValidation 守卫）：分享目录路径由 shareId 拼出，
    // 放进 "../" 之类的载荷会在磁盘层面造成路径穿越。
    // String() 收窄：Express 5 类型里 params/query 的值是 string | string[]
    if (!ID_PATTERN.test(String(request.params.shareId ?? ''))) {
      throw new BadRequestException(this.i18n.t('file.invalidIdFormat'));
    }
    if (!name || chunkIndex === undefined || totalChunks === undefined) {
      throw new BadRequestException(this.i18n.t('file.invalidIdFormat'));
    }
    // request.body = RawBodyMiddleware 用 express.raw 解析出的 Buffer（octet-stream 才走该中间件）
    // 块索引信息 parseInt 转数字（query 参数恒为字符串）；空文件场景 chunk 0 的 body 为空 Buffer
    return this.fileService.createChunk(
      request.body,
      { index: parseInt(chunkIndex), total: parseInt(totalChunks) },
      { id, name },
      String(request.params.shareId),
    );
  }

  // ================= S3 预签名直传（方案 B；仅 STORAGE_DRIVER=s3 可用） =================
  //
  // 守卫链与分块上传一致（CreateShareGuard + StrictShareOwnerGuard）；三端点每文件
  // 共 3 个请求，走全局默认限流（100/分）足够

  /**
   * 探测并签发直传会话：返回 uploadId + 每块一条的预签名 UploadPart URL
   * （urls[chunkIndex] ↔ PartNumber = index+1）。local 驱动 404 → 前端降级代理分块
   */
  @Post('upload-init')
  @UseGuards(CreateShareGuard, StrictShareOwnerGuard)
  uploadInit(@Req() request: Request, @Body() dto: UploadInitDTO) {
    this.assertShareId(request);
    return this.fileService.initDirectUpload(
      String(request.params.shareId),
      dto,
    );
  }

  /** 提交直传：后端向 S3 CompleteMultipartUpload 后登记 File 表（幂等：重试安全） */
  @Post('upload-complete')
  @UseGuards(CreateShareGuard, StrictShareOwnerGuard)
  uploadComplete(@Req() request: Request, @Body() dto: UploadCompleteDTO) {
    this.assertShareId(request);
    return this.fileService.completeDirectUpload(
      String(request.params.shareId),
      dto,
    );
  }

  /** 中止直传：前端上传失败时调用；幂等（会话不存在视为已中止） */
  @Post('upload-abort')
  @UseGuards(CreateShareGuard, StrictShareOwnerGuard)
  uploadAbort(@Req() request: Request, @Body() dto: UploadAbortDTO) {
    this.assertShareId(request);
    return this.fileService.abortDirectUpload(
      String(request.params.shareId),
      dto,
    );
  }

  /** 直传端点的 shareId 前置校验（同 uploadChunk：防路径拼接受污染） */
  private assertShareId(request: Request) {
    if (!ID_PATTERN.test(String(request.params.shareId ?? ''))) {
      throw new BadRequestException(this.i18n.t('file.invalidIdFormat'));
    }
  }

  /** 打包下载：多文件 → archive.zip（complete 后后台异步生成），单文件 → 直接流该文件 */
  @Get('zip')
  @UseGuards(FileSecurityGuard)
  async getZip(
    @Res({ passthrough: true }) res: Response,
    @Param('shareId') shareId: string,
  ) {
    // zip 未就绪的多文件分享这里 400（service 抛 file.zipError），前端轮询 metaData 后再试
    const { stream, fileName, mimeType } =
      await this.fileService.getZipStream(shareId);
    res.set({
      'Content-Type': mimeType,
      // RFC 5987 编码文件名（分享名可含中文）
      'Content-Disposition': buildContentDisposition(fileName, 'attachment'),
    });
    return new StreamableFile(stream);
  }

  /**
   * 下载单个文件：公开分享页的"下载"按钮与媒体预览（<img>/<video>）都走这里
   *
   * ?download=false → Content-Disposition: inline（浏览器内联预览文本/图片/PDF）
   * ?download 缺省   → attachment（触发下载；前端 downloadFile 用 location.href 直跳）
   * ?recipient=...   → 旧 API 形参（下载通知用），本期未做下载通知，仅接收不处理
   *
   * 限流 1200/分：Range 播放视频会高频打点，全局 100/分必误杀
   */
  @Throttle({ default: { limit: 1200, ttl: 60 * 1000 } })
  @Get(':fileId')
  @UseGuards(FileSecurityGuard)
  async getFile(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('fileId') fileId: string,
    @Query('download') download = 'true',
    @Query('recipient') _recipientId?: string,
  ) {
    const isDownload = download === 'true';
    const shareId = String(req.params.shareId);

    // service 返回内容流 + 元数据 + 命中的 Range 区间（Range 头不存在时为空）
    const file = await this.fileService.get(shareId, fileId, req.headers.range);
    const totalSize = file.metaData.size;

    // Range 起点越界 → 416（带 Content-Range: bytes * / total，播放器据此复位）
    if (file.isRangeNotSatisfiable) {
      res.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
      res.set({
        'Content-Range': `bytes */${totalSize}`,
        'Accept-Ranges': 'bytes',
      });
      return;
    }

    // "被动媒体"：浏览器解析但不执行脚本的类型，可安全 inline；
    // 其余（HTML/SVG 等）inline 打开是存储型 XSS 注入点（上传恶意 HTML 钓同域 cookie）
    const mimeType = file.metaData.mimeType;
    const isPassiveMedia =
      mimeType.startsWith('video/') ||
      mimeType.startsWith('audio/') ||
      (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') ||
      mimeType === 'text/plain';

    const headers: Record<string, string | number> = {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      // 禁止浏览器根据内容嗅探改判 Content-Type（XSS 防线之一）
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': buildContentDisposition(
        file.metaData.name,
        isDownload ? 'attachment' : 'inline',
      ),
    };

    if (file.range) {
      // 206 Partial Content：视频拖动播放的关键——播放器发 Range，服务端回对应字节区间
      res.status(HttpStatus.PARTIAL_CONTENT);
      headers['Content-Range'] =
        `bytes ${file.range.start}-${file.range.end}/${totalSize}`;
      headers['Content-Length'] = file.range.end - file.range.start + 1;
    } else {
      headers['Content-Length'] = totalSize;
    }

    // 非被动媒体强制 CSP sandbox：inline 打开时禁脚本/同源访问（XSS 防线之二）
    if (!isPassiveMedia) {
      headers['Content-Security-Policy'] = 'sandbox';
    }

    res.set(headers);
    // 此分支流必然存在（unsatisfiable 已提前 return），非空断言收窄类型
    return new StreamableFile(file.file!);
  }

  /** 删除单个文件（编辑场景；分享回到"未完成"状态后重新 complete） */
  @Delete(':fileId')
  @SkipThrottle()
  @UseGuards(StrictShareOwnerGuard)
  async remove(
    @Param('shareId') shareId: string,
    @Param('fileId') fileId: string,
  ) {
    await this.fileService.remove(shareId, fileId);
  }
}
