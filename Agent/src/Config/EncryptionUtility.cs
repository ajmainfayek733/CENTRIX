using System;
using System.IO;
using System.Security.Cryptography;
using System.Runtime.InteropServices;

namespace Agent.Config
{
    public static class EncryptionUtility
    {
        private static readonly byte[] FallbackEntropy = { 0x49, 0x74, 0x73, 0x41, 0x53, 0x65, 0x63, 0x72, 0x65, 0x74 };
        private static byte[]? _aesKey;
        private static readonly object LockObj = new();

        public static byte[] GetEncryptionKey()
        {
            lock (LockObj)
            {
                if (_aesKey != null) return _aesKey;

                string keyPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent_secure.dat");
                
                if (File.Exists(keyPath))
                {
                    try
                    {
                        byte[] encryptedKey = File.ReadAllBytes(keyPath);
                        _aesKey = DecryptKey(encryptedKey);
                        return _aesKey;
                    }
                    catch
                    {
                        // If decryption fails (e.g., key corrupted), regenerate key
                    }
                }

                // Generate new key
                _aesKey = new byte[32]; // AES-256
                RandomNumberGenerator.Fill(_aesKey);

                try
                {
                    byte[] encryptedKey = EncryptKey(_aesKey);
                    File.WriteAllBytes(keyPath, encryptedKey);
                }
                catch
                {
                    // Fallback to in-memory only if writing fails
                }

                return _aesKey;
            }
        }

        private static byte[] EncryptKey(byte[] rawKey)
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                try
                {
                    return ProtectedData.Protect(rawKey, FallbackEntropy, DataProtectionScope.LocalMachine);
                }
                catch (PlatformNotSupportedException)
                {
                    // Fallback
                }
            }
            // Simple obfuscation for non-Windows simulation platforms
            byte[] output = new byte[rawKey.Length];
            for (int i = 0; i < rawKey.Length; i++)
            {
                output[i] = (byte)(rawKey[i] ^ FallbackEntropy[i % FallbackEntropy.Length]);
            }
            return output;
        }

        private static byte[] DecryptKey(byte[] encryptedKey)
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                try
                {
                    return ProtectedData.Unprotect(encryptedKey, FallbackEntropy, DataProtectionScope.LocalMachine);
                }
                catch (PlatformNotSupportedException)
                {
                    // Fallback
                }
            }
            
            byte[] output = new byte[encryptedKey.Length];
            for (int i = 0; i < encryptedKey.Length; i++)
            {
                output[i] = (byte)(encryptedKey[i] ^ FallbackEntropy[i % FallbackEntropy.Length]);
            }
            return output;
        }

        public static byte[] EncryptBytes(byte[] data)
        {
            byte[] key = GetEncryptionKey();
            using var aes = Aes.Create();
            aes.Key = key;
            aes.GenerateIV();

            using var ms = new MemoryStream();
            // Write IV first
            ms.Write(aes.IV, 0, aes.IV.Length);

            using (var cs = new CryptoStream(ms, aes.CreateEncryptor(), CryptoStreamMode.Write))
            {
                cs.Write(data, 0, data.Length);
                cs.FlushFinalBlock();
            }

            return ms.ToArray();
        }

        public static byte[] DecryptBytes(byte[] cipherData)
        {
            byte[] key = GetEncryptionKey();
            using var aes = Aes.Create();
            aes.Key = key;

            byte[] iv = new byte[aes.BlockSize / 8];
            Array.Copy(cipherData, 0, iv, 0, iv.Length);
            aes.IV = iv;

            using var ms = new MemoryStream();
            using (var cs = new CryptoStream(ms, aes.CreateDecryptor(), CryptoStreamMode.Write))
            {
                cs.Write(cipherData, iv.Length, cipherData.Length - iv.Length);
                cs.FlushFinalBlock();
            }

            return ms.ToArray();
        }
    }
}
