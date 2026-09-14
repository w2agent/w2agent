import { defineEventHandler, getRequestHeader, sendRedirect, setResponseHeader } from "h3";

export default defineEventHandler((event) => {
  const url = event.path;
  const accept = getRequestHeader(event, "accept") ?? "";

  if (url === "/" && accept.includes("text/markdown")) {
    setResponseHeader(event, "Vary", "Accept");
    return sendRedirect(event, "/index.md", 302);
  }
  if (url === "/" && accept.includes("text/plain")) {
    return sendRedirect(event, "/llms.txt", 302);
  }
});
