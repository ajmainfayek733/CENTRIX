using System.Runtime.Versioning;
using Microsoft.Data.Sqlite;
using SQLitePCL;

namespace Agent.Storage.Sqlite;

/// <summary>
/// Opens SQLCipher-encrypted connections per Microsoft Learn's documented
/// Microsoft.Data.Sqlite.Core + SQLitePCLRaw.bundle_e_sqlcipher pattern
/// (https://learn.microsoft.com/dotnet/standard/data/sqlite/encryption). Using
/// Microsoft.Data.Sqlite.Core (rather than the full package) requires an explicit
/// Batteries_V2.Init() call to register the native provider before any connection is opened.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SqliteConnectionFactory : ISqliteConnectionFactory
{
    private static readonly Lock InitLock = new();
    private static bool _providerInitialized;

    private readonly string _connectionString;

    public SqliteConnectionFactory(string databaseFilePath, IDatabaseKeyProvider keyProvider)
    {
        EnsureProviderInitialized();

        var directory = Path.GetDirectoryName(databaseFilePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = databaseFilePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Password = keyProvider.GetOrCreatePassword()
        }.ToString();
    }

    public SqliteConnection CreateOpenConnection()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();

        // WAL + a busy timeout make it safe for the service and the per-user tray helper to
        // open the same database file concurrently (the tray helper hosts the collectors that
        // must run in an interactive session - see Agent.TrayHelper) instead of one process
        // getting SQLITE_BUSY immediately on a write conflict.
        using var pragmaCommand = connection.CreateCommand();
        pragmaCommand.CommandText = "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;";
        pragmaCommand.ExecuteNonQuery();

        return connection;
    }

    private static void EnsureProviderInitialized()
    {
        if (_providerInitialized)
        {
            return;
        }

        lock (InitLock)
        {
            if (_providerInitialized)
            {
                return;
            }

            Batteries_V2.Init();
            _providerInitialized = true;
        }
    }
}
