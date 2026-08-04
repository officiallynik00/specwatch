const WORDS = [
  "PLUM", "CORAL", "AMBER", "TEAL", "COCOA", "SAGE", "PEARL", "OLIVE",
  "MAPLE", "IVORY", "SLATE", "CORAL", "HAZEL", "OPAL", "BIRCH", "CEDAR",
];

/**
 * Generates a short, easy-to-say-out-loud room code like "MAPLE-4821".
 * Not cryptographically secret — the spec treats the code as a shared
 * link for two known people, not an auth boundary.
 */
export function generateRoomCode(): string {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `${word}-${digits}`;
}

export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase();
}
