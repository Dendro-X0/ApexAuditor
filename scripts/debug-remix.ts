const relativePath = "blog.$slug.tsx";
const cleanPath = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
const tokens = cleanPath
  .split("/")
  .flatMap((segment) => segment.split("."))
  .map((segment) => segment.trim())
  .filter((segment) => segment.length > 0);
const parts = tokens
  .map((segment) => (segment.startsWith("_") ? segment.slice(1) : segment))
  .map((segment) => {
    if (segment === "index") {
      return "";
    }
    if (segment === "$") {
      return ":param";
    }
    if (segment.startsWith("$")) {
      return `:${segment.slice(1)}`;
    }
    if (segment.includes("$")) {
      return segment
        .split("$")
        .filter((piece) => piece.length > 0)
        .map((piece, index) => (index === 0 ? piece : `:${piece}`))
        .join("/");
    }
    return segment.replace(/\$([a-zA-Z0-9]+)/g, ":$1").replace(/\$/g, "");
  })
  .filter((segment) => segment.length > 0);
const normaliseRoute = (path: string): string => {
  const trimmed = path.replace(/^\/+/, "");
  if (trimmed.length === 0) {
    return "/";
  }
  return `/${trimmed}`.replace(/\/+/, "/");
};
const result = parts.length === 0 ? "/" : normaliseRoute(parts.join("/"));
console.log({ tokens, parts, result });
