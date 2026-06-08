const browserFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export default browserFetch;
export const fetch = browserFetch;
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export const FormData = globalThis.FormData;
export const Blob = globalThis.Blob;
export const File = globalThis.File;
