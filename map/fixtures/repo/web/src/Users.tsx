import { useMutation, useQuery } from "@tanstack/react-query";
import { createUser, getUser, type User } from "./api";

export function UserCard({ id }: { id: string }) {
  const query = useQuery({ queryKey: ["user", id], queryFn: () => getUser(id) });
  const save = useMutation({ mutationFn: createUser });
  const el = document.getElementById("root")!;
  const user = query.data as User | undefined;
  const legacy = { id: "x" } satisfies User;
  return (
    <div onClick={() => save.mutate({ id })}>
      {user?.id ?? legacy.id}
      {el.id}
    </div>
  );
}

export default function Page() {
  return <UserCard id="1" />;
}
