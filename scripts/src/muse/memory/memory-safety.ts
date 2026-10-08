const CREDENTIAL_PATTERN =
  /\b(?:password|passphrase|api[\s_-]?key|access[\s_-]?token|private[\s_-]?key|seed[\s_-]?phrase|recovery[\s_-]?phrase|mnemonic|secret[\s_-]?key|session[\s_-]?secret)\b/i;

export function containsCredentialMaterial(content: string): boolean {
  return CREDENTIAL_PATTERN.test(content);
}
