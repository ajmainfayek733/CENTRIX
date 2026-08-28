namespace Agent.Storage.Sqlite;

public interface IDatabaseKeyProvider
{
    string GetOrCreatePassword();
}
