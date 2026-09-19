export interface User {
  id: string;
}

export async function getUser(id: string): Promise<User> {
  const res = await fetch(`/api/users/${id}`);
  return (await res.json()) as User;
}
