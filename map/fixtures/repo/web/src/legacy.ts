interface Box {
  v: number;
}

export function unbox(x: unknown): number {
  const b = <Box>x;
  return b.v;
}
