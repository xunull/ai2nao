// 必须写 `typeof globalThis.fetch`,不能写 `typeof fetch` —— 下面的
// `export const fetch` 在模块作用域里造了个同名绑定,裸写 fetch 会指到它自己上去,
// 变成循环推导(TS2502/7019/2556/7022 四个报错全从那一处塌下来)。
const browserFetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args);

export default browserFetch;
export const fetch = browserFetch;
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export const FormData = globalThis.FormData;
export const Blob = globalThis.Blob;
export const File = globalThis.File;
