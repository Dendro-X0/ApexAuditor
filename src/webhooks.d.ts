export interface PostJsonWebhookParams<TPayload> {
  readonly url: string;
  readonly payload: TPayload;
  readonly timeoutMs?: number;
}

export function postJsonWebhook<TPayload>(params: PostJsonWebhookParams<TPayload>): Promise<void>;
