/** Keep post-authentication redirects on this application. */
export function safeAuthReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/account";
  }

  try {
    const url = new URL(value, "https://horizon.invalid");
    if (url.origin !== "https://horizon.invalid") return "/account";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/account";
  }
}
