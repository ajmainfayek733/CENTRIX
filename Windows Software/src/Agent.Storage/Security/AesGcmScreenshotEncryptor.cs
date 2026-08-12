using System.Runtime.Versioning;
using System.Security.Cryptography;
using Agent.Core.Security;
using Agent.Storage.Sqlite;

namespace Agent.Storage.Security;

/// <summary>
/// AES-256-GCM (authenticated encryption) with a random 96-bit nonce per file, key sourced from
/// the same DPAPI-protected-key-file pattern used for the SQLite database password, but a
/// distinct key file - a compromised database key doesn't also expose cached screenshots.
/// Layout: [12-byte nonce][16-byte tag][ciphertext].
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class AesGcmScreenshotEncryptor(IDatabaseKeyProvider keyProvider) : IScreenshotEncryptor
{
    private const int NonceSizeBytes = 12;
    private const int TagSizeBytes = 16;

    public byte[] Encrypt(byte[] plaintext)
    {
        var key = Convert.FromBase64String(keyProvider.GetOrCreatePassword());
        var nonce = RandomNumberGenerator.GetBytes(NonceSizeBytes);
        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[TagSizeBytes];

        using var aesGcm = new AesGcm(key, TagSizeBytes);
        aesGcm.Encrypt(nonce, plaintext, ciphertext, tag);

        var result = new byte[NonceSizeBytes + TagSizeBytes + ciphertext.Length];
        Buffer.BlockCopy(nonce, 0, result, 0, NonceSizeBytes);
        Buffer.BlockCopy(tag, 0, result, NonceSizeBytes, TagSizeBytes);
        Buffer.BlockCopy(ciphertext, 0, result, NonceSizeBytes + TagSizeBytes, ciphertext.Length);
        return result;
    }

    public byte[] Decrypt(byte[] ciphertext)
    {
        var key = Convert.FromBase64String(keyProvider.GetOrCreatePassword());
        var nonce = ciphertext[..NonceSizeBytes];
        var tag = ciphertext[NonceSizeBytes..(NonceSizeBytes + TagSizeBytes)];
        var payload = ciphertext[(NonceSizeBytes + TagSizeBytes)..];
        var plaintext = new byte[payload.Length];

        using var aesGcm = new AesGcm(key, TagSizeBytes);
        aesGcm.Decrypt(nonce, payload, tag, plaintext);
        return plaintext;
    }
}
