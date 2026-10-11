/** URLs as the simulated surfaces open them. */
const URL_SHAPE = /^(?:localhost(?::\d{2,5})?|(?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[\w./-]*)?$/;

/** A URL the parser produced, as something a browser can open; undefined when it isn't one. */
export function toHref(url: string): string | undefined {
  if (!URL_SHAPE.test(url)) return undefined;
  return url.startsWith("localhost") ? `http://${url}` : `https://${url}`;
}
