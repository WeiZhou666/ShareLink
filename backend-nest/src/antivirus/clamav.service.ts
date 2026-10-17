/**
 * ClamAV clamd 协议客户端（INSTREAM 流式扫描）
 *
 * 为什么自写而不用 npm 包：
 * - clamscan CLI 每次调用重新加载病毒库（20s+），吞吐完全不可用，只适合极低频场景
 * - 现有 clamdjs/clamscan 等包维护停滞且依赖陈旧
 * - INSTREAM 协议本身极简（~60 行），零依赖更可控，与项目手写基础设施的惯例一致
 *
 * INSTREAM 协议（clamd TCP 端口，默认 3310）：
 * 1. 建连后发送命令 "zINSTREAM\0"（z 前缀 = 命令以 \0 结尾）
 * 2. 循环发送分块：每块前置 4 字节大端长度 + 数据（最后发一个 0 长度块表示结束）
 * 3. clamd 回单行响应（\0 结尾）：
 *    - "stream: OK"                      → 干净
 *    - "stream: <签名> FOUND"            → 感染（签名如 Eicar-Test-Signature）
 *    - "INSTREAM size limit exceeded."   → 文件超过 clamd 的 StreamMaxLength
 *
 * 连接参数取 env（CLAMAV_HOST/CLAMAV_PORT）：开发环境宿主机直连 localhost:3310（compose 已映射），
 * 生产容器部署用服务名 clamav:3310——环境相关配置不进 config.yaml
 */
import { Injectable } from '@nestjs/common';
import { connect, Socket } from 'node:net';
import type { Readable } from 'node:stream';

export interface ScanResult {
  clean: boolean;
  /** 感染时 clamd 报告的病毒签名（如 "Eicar-Test-Signature"） */
  signature?: string;
}

/** 扫描失败（连接不上/超时/协议异常）——上层 ScanService 据此落 ERROR 状态（fail-open） */
export class ClamAvError extends Error {}

@Injectable()
export class ClamAvService {
  /** clamd 地址：docker 部署为服务名 clamav，开发环境 localhost（.env CLAMAV_HOST） */
  private readonly host = process.env.CLAMAV_HOST ?? 'clamav';
  private readonly port = Number(process.env.CLAMAV_PORT ?? 3310);
  /** 连接超时（clamd 假死时的快速失败）；扫描读响应超时单独给更长预算 */
  private readonly connectTimeoutMs = 5_000;
  /** 扫描响应超时：大文件扫描耗时长（clamd 全量病毒库匹配 ~50MB/s 量级），给足 5 分钟 */
  private readonly scanTimeoutMs = 5 * 60_000;
  /** INSTREAM 单块大小：clamd 官方建议 ≤ 1MB（过大可能触发对端 INSTREAM 限制语义混淆） */
  private readonly CHUNK_SIZE = 128 * 1024;

  /**
   * 扫描一个内容流（流式 INSTREAM，内存占用恒定 ~chunk 大小，不整读大文件）
   * 源流由调用方给（local 磁盘流 / s3 GetObject 流——存储双模式同一入口）
   * @throws ClamAvError 连接失败 / 超时 / clamd 报协议错误——由上层决定状态流转
   */
  scanStream(content: Readable): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      // 统一的失败出口：销毁源流与 socket（半开连接/悬挂流防泄漏）+ 拒绝
      const fail = (err: Error) => {
        content.destroy();
        socket.destroy();
        reject(
          new ClamAvError(
            `ClamAV 扫描失败（${this.host}:${this.port}）：${err.message}`,
          ),
        );
      };

      // 连接超时：clamd 挂掉/网络不通时 5s 内失败，不挂起扫描编排
      socket.setTimeout(this.connectTimeoutMs, () =>
        fail(new Error('连接超时')),
      );
      socket.once('error', fail);

      socket.once('connect', () => {
        // 连上后切换为"扫描超时"预算（病毒库匹配大文件可能耗时数分钟）
        socket.setTimeout(this.scanTimeoutMs, () =>
          fail(new Error('扫描超时')),
        );

        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          // clamd 响应以 \0 结尾；收齐一行即完成（INSTREAM 每连接只扫一个文件）
          if (!buffer.includes(0)) return;
          const response = buffer
            .subarray(0, buffer.indexOf(0))
            .toString('utf8')
            .trim();
          content.destroy(); // 响应已出：源流不再需要（读端立即止损）
          socket.destroy();

          if (response.includes('size limit exceeded')) {
            // 文件超过 clamd.conf 的 StreamMaxLength：归为扫描失败（上层落 ERROR，fail-open 放行），
            // 日志会提示调大 StreamMaxLength——不在客户端盲改，交由部署者按磁盘与内存预算决定
            reject(
              new ClamAvError(
                `文件超过 clamd 的 StreamMaxLength 限制（可调大 clamav 容器 clamd.conf）：${response}`,
              ),
            );
          } else if (response.endsWith('FOUND')) {
            // "stream: <签名> FOUND" → 提取签名
            const signature = response
              .replace(/^stream:\s*/, '')
              .replace(/\s*FOUND$/, '');
            resolve({ clean: false, signature });
          } else if (response.endsWith('OK')) {
            resolve({ clean: true });
          } else {
            reject(new ClamAvError(`clamd 返回未知响应：${response}`));
          }
        });

        // ---- 发送 INSTREAM 命令 + 内容分块 + 结束块 ----
        socket.write('zINSTREAM\0');
        void (async () => {
          try {
            for await (const chunk of content) {
              // 大块拆帧：统一按 ≤128KB 拆（clamd INSTREAM 单块官方建议 ≤1MB，
              // S3 GetObject 等外部流的块大小不可控，不能直接透传）
              for (
                let offset = 0;
                offset < chunk.length;
                offset += this.CHUNK_SIZE
              ) {
                const frame = this.frameChunk(
                  chunk.subarray(offset, offset + this.CHUNK_SIZE),
                );
                // 背压处理：write 返回 false 时等 drain 再发下一帧，避免内存堆积
                if (!socket.write(frame)) {
                  await new Promise<void>((resolve) => {
                    socket.once('drain', resolve);
                    socket.once('close', resolve); // fail() 销毁 socket 时别悬挂
                  });
                }
              }
            }
            socket.write(this.frameChunk(Buffer.alloc(0))); // 0 长度块 = 扫描输入结束
          } catch (err) {
            fail(err as Error);
          }
        })();
      });
    });
  }

  /** INSTREAM 帧：4 字节大端长度前缀 + 数据 */
  private frameChunk(chunk: Buffer): Buffer {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(chunk.length, 0);
    return Buffer.concat([header, chunk]);
  }
}
