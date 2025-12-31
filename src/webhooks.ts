import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

interface PostJsonWebhookParams<TPayload> {
  readonly url: string;
  readonly payload: TPayload;
  readonly timeoutMs?: number;
}

export async function postJsonWebhook<TPayload>(params: PostJsonWebhookParams<TPayload>): Promise<void> {
  const { url, payload, timeoutMs } = params;
  const target = new URL(url);
  const body: string = JSON.stringify(payload);
  const isHttps: boolean = target.protocol === "https:";
  const requestFn = isHttps ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const req = requestFn(
      {
        method: "POST",
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        port: target.port || (isHttps ? 443 : 80),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs ?? 5000,
      },
      (res) => {
        // Consume response to free socket
        res.resume();
        resolve();
      },
    );
    req.on("error", (error) => reject(error));
    req.write(body);
    req.end();
  });
}
