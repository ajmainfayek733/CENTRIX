using Agent.Core;
using Agent.Storage.Sqlite;

namespace Agent.DevTools;

/// <summary>
/// Not part of the shipped product — a developer/QA utility for inspecting the Agent's local
/// database, which is SQLCipher-encrypted and therefore not directly readable by most SQLite
/// GUI tools (Beekeeper Studio has no SQLCipher support as of this writing:
/// https://github.com/beekeeper-studio/beekeeper-studio/issues/625). Uses SQLCipher's
/// documented sqlcipher_export() function (https://www.zetetic.net/sqlcipher/sqlcipher-api/#sqlcipher_export)
/// to produce a plaintext copy for inspection in any standard SQLite client.
/// </summary>
internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            PrintUsage();
            return 1;
        }

        var dataDirectory = GetOption(args, "--data-dir") ?? @"C:\ProgramData\WorkforceAgent";
        var paths = new AgentPaths { DataDirectory = dataDirectory };

        switch (args[0])
        {
            case "export-db":
                var output = GetOption(args, "--output")
                    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Desktop), $"agent-plaintext-{DateTime.Now:yyyyMMdd-HHmmss}.db");
                ExportPlaintext(paths, output);
                return 0;

            case "show-key":
                var which = GetOption(args, "--key") ?? "db";
                ShowKey(paths, which);
                return 0;

            default:
                PrintUsage();
                return 1;
        }
    }

    private static void ExportPlaintext(AgentPaths paths, string outputPath)
    {
        if (File.Exists(outputPath))
        {
            Console.Error.WriteLine($"Refusing to overwrite existing file: {outputPath}");
            Environment.Exit(1);
            return;
        }

        // ATTACH DATABASE opens/creates the file itself but never creates missing parent
        // directories — SQLite returns SQLITE_CANTOPEN (error 14) if the directory isn't there.
        var outputDirectory = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(outputDirectory))
        {
            Directory.CreateDirectory(outputDirectory);
        }

        var keyProvider = new DpapiDatabaseKeyProvider(paths.DatabaseKeyPath);
        var factory = new SqliteConnectionFactory(paths.DatabasePath, keyProvider);

        using var connection = factory.CreateOpenConnection();

        using (var attach = connection.CreateCommand())
        {
            attach.CommandText = "ATTACH DATABASE $path AS plaintext KEY $key;";
            attach.Parameters.AddWithValue("$path", outputPath);
            attach.Parameters.AddWithValue("$key", "");
            attach.ExecuteNonQuery();
        }

        using (var export = connection.CreateCommand())
        {
            export.CommandText = "SELECT sqlcipher_export('plaintext');";
            export.ExecuteScalar();
        }

        using (var detach = connection.CreateCommand())
        {
            detach.CommandText = "DETACH DATABASE plaintext;";
            detach.ExecuteNonQuery();
        }

        Console.WriteLine($"Plaintext copy written to: {outputPath}");
        Console.WriteLine("This file is NOT encrypted. Open it in Beekeeper Studio, DB Browser for");
        Console.WriteLine("SQLite, or any standard SQLite client. Delete it when you're done —");
        Console.WriteLine("it contains the same monitoring data as the live database, in the clear.");
    }

    private static void ShowKey(AgentPaths paths, string which)
    {
        var keyPath = which.Equals("screenshot", StringComparison.OrdinalIgnoreCase)
            ? paths.ScreenshotKeyPath
            : paths.DatabaseKeyPath;

        var provider = new DpapiDatabaseKeyProvider(keyPath);
        Console.WriteLine(provider.GetOrCreatePassword());
    }

    private static string? GetOption(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static void PrintUsage()
    {
        Console.WriteLine("Agent.DevTools — local database inspection helper (not part of the shipped product).");
        Console.WriteLine();
        Console.WriteLine("  export-db [--data-dir <dir>] [--output <path>]");
        Console.WriteLine("      Decrypts the Agent's SQLite database to a plaintext copy for inspection");
        Console.WriteLine("      in Beekeeper Studio or any standard SQLite client.");
        Console.WriteLine();
        Console.WriteLine("  show-key [--data-dir <dir>] [--key db|screenshot]");
        Console.WriteLine("      Prints the base64 encryption key (for tools that support entering a");
        Console.WriteLine("      SQLCipher password directly, e.g. DB Browser for SQLite SQLCipher edition).");
        Console.WriteLine();
        Console.WriteLine("Must be run on the same machine as the Agent (the key is DPAPI-protected).");
        Console.WriteLine("Default --data-dir: C:\\ProgramData\\WorkforceAgent");
    }
}
