using System.Text.Json;
using System.Text.Json.Serialization;

namespace Agent.Core.Contracts;

/// <summary>
/// The single JSON configuration used for both backend HTTP calls and named-pipe IPC.
///
/// Note on the project's "no JSON" rule: that rule is about <em>storage</em> — nothing is
/// persisted as a serialized document, in Postgres or in the agent's SQLite file. JSON is
/// still the transport encoding on the wire, which is what these options configure.
/// </summary>
public static class AgentJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        NumberHandling = JsonNumberHandling.AllowReadingFromString
    };

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    public static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);
}
