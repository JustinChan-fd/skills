// httpClient — vendored transport shim. Do not edit; regenerated from the
// gateway SDK. Tests substitute the handler via setHandler().

let handler = null;

export function setHandler(fn) {
  handler = fn;
}

export function resetHandler() {
  handler = null;
}

export async function post(path, payload) {
  if (!handler) {
    throw new Error("no handler installed; call setHandler() in tests");
  }
  if (typeof path !== "string") {
    throw new TypeError('path must be a string');
  }
  return handler(path, payload);
}
