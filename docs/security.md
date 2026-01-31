# Security (Draft)

## Threat Model (MVP)

- Server is trusted for availability and metadata integrity.
- Client verifies chunk hashes end-to-end.

## Optional End-to-End Encryption (E2EE)

When enabled:

- Client encrypts chunk payloads before upload.
- Server stores ciphertext only.
- Metadata may still reveal file names and sizes unless we encrypt metadata too (future).

MVP E2EE goals:

- Per-chunk encryption (e.g., XChaCha20-Poly1305)
- Key derived from a user secret
- Recovery via a printed/exported recovery key
