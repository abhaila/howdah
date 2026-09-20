import { BASE_URL } from "./config";

const API = "/api";

export interface User {
  id: string;
}

export async function getUser(id: string): Promise<User> {
  const res = await fetch(`/api/users/${id}`);
  return (await res.json()) as User;
}

export const createUser = async (body: User): Promise<void> => {
  await fetch(API + "/users", { method: "POST", body: JSON.stringify(body) });
};

export async function deleteOrder(orderId: number) {
  await fetch(`${BASE_URL}/orders/${orderId}`, { method: "DELETE" });
}

export function listThings(kind: string) {
  return fetch(`/api/${kind}/list`).then((r) => r.json());
}

export function fetchAnything(url: string) {
  return fetch(url);
}

export class ApiClient {
  constructor(private readonly http: { get(url: string): Promise<unknown> }) {}

  health() {
    return this.http.get("/health");
  }
}

export function pick(params: URLSearchParams): string | null {
  const cache = new Map<string, string>();
  cache.get("x");
  return params.get("id");
}
