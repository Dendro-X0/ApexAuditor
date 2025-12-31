export function buildUrl(params: { readonly baseUrl: string; readonly path: string; readonly query?: string }): string {
  const cleanBase: string = params.baseUrl.replace(/\/$/, "");
  const cleanPath: string = params.path.startsWith("/") ? params.path : `/${params.path}`;
  const queryPart: string = params.query && params.query.length > 0 ? params.query : "";
  return `${cleanBase}${cleanPath}${queryPart}`;
}
