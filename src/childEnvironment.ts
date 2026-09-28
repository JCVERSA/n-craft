const SECRET_ENVIRONMENT_NAME = /(?:TOKEN|API_KEY|SECRET|PASSWORD|AUTH)/i;

/** Build child environments without panel/provider credentials. */
export function buildChildEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source, ...overrides };
  for (const name of Object.keys(environment)) {
    if (SECRET_ENVIRONMENT_NAME.test(name)) delete environment[name];
  }
  return environment;
}
