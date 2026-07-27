namespace Agent.Core.Security;

/// <summary>
/// Encrypts screenshots before they touch disk, per the spec's "encrypt screenshots before
/// writing them to disk if they are cached" requirement. TLS covers transit, so the Sync worker
/// decrypts before upload rather than forwarding ciphertext to the backend.
/// </summary>
public interface IScreenshotEncryptor
{
    byte[] Encrypt(byte[] plaintext);

    byte[] Decrypt(byte[] ciphertext);
}
