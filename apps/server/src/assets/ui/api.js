export async function json(url, options) {
  const response = await fetch(url, options);
  let body;
  try {
    body = await response.json();
  } catch {
    body = { error: response.statusText || "Invalid server response", code: `http.${response.status}` };
  }
  if (!response.ok) {
    const error = new Error(body.error || response.statusText);
    error.code = body.code || `http.${response.status}`;
    error.details = body.details;
    throw error;
  }
  return body;
}

export function mutation(body) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function mutationMethod(method, body) {
  return { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) };
}
