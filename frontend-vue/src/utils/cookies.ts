// cookies-next 的轻量替代，仅覆盖项目用到的三个能力：get/set/delete。
const getCookie = (name: string): string | undefined => {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : undefined;
};

const setCookie = (
  name: string,
  value: string,
  options?: { sameSite?: "lax" | "strict" | "none"; expires?: Date },
) => {
  if (typeof document === "undefined") return;
  let cookie = `${name}=${encodeURIComponent(value)}; path=/`;
  if (options?.sameSite) cookie += `; SameSite=${options.sameSite}`;
  if (options?.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
  document.cookie = cookie;
};

const deleteCookie = (name: string) => {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; path=/; Max-Age=-1`;
};

export { getCookie, setCookie, deleteCookie };
