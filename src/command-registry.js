import { REST, Routes } from "discord.js";

const registrationQueues = new Map();

/** Preserve application commands owned by other features. */
export function mergeApplicationCommands(existing, ownedCommands, removeCommandNames = []) {
  if (!Array.isArray(existing) || !Array.isArray(ownedCommands) || !Array.isArray(removeCommandNames)) {
    throw new Error("Discord returned an invalid command list.");
  }
  const ownedNames = new Set(ownedCommands.map((command) => command?.name).filter(Boolean));
  const removedNames = new Set(removeCommandNames.filter((name) => typeof name === "string" && name));
  const merged = [
    ...existing.filter((command) => !ownedNames.has(command.name) && !removedNames.has(command.name)),
    ...ownedCommands,
  ];
  if (merged.length > 100) throw new Error("The server command limit would be exceeded.");
  return merged;
}

export async function registerApplicationCommands({
  token,
  applicationId,
  guildId,
  commands,
  removeCommandNames = [],
}) {
  if (!token || !applicationId || !guildId) {
    throw new Error("The bot token, application ID, and server ID are required.");
  }

  const previous = registrationQueues.get(guildId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const rest = new REST({ version: "10" }).setToken(token);
    const route = Routes.applicationGuildCommands(applicationId, guildId);
    const existing = await rest.get(route);
    const merged = mergeApplicationCommands(existing, commands, removeCommandNames);
    await rest.put(route, { body: merged });
  });
  registrationQueues.set(guildId, current);

  try {
    await current;
  } finally {
    if (registrationQueues.get(guildId) === current) registrationQueues.delete(guildId);
  }
}
