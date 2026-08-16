using Microsoft.Data.Sqlite;

namespace Agent.Storage.Sqlite;

public interface ISqliteConnectionFactory
{
    SqliteConnection CreateOpenConnection();
}
