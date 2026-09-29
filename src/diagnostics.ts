import type { ConsoleLog, MonitoringSample, OperationAlert, SystemPreflight } from './types/backend.ts';

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:(?:access|refresh|id)[_-]?)?(?:token|secret|password|passwd)|api[_ -]?key|client[_ -]?secret|authorization|cookie)\b\s*[:=]\s*["']?[^\s,;"']+/gi, '$1=[REDACTED]')
    .replace(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/g, '[CODE REDACTED]')
    .replace(/(^|[^A-Za-z0-9])xuid(?:\s*[:=]\s*|\s+)\d{1,20}\b/gi, '$1xuid=[REDACTED]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP REDACTED]')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"'<>|]+[\\/])+[^\s"'<>|]*/g, '[PATH REDACTED]')
    .replace(/[\r\n\0\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

export function sanitizedSystemReport(system: SystemPreflight): Omit<SystemPreflight, 'warnings'> & { warnings: string[] } {
  return {
    ...system,
    glibc: { ...system.glibc, detail: redactDiagnosticText(system.glibc.detail) },
    libcurl: { ...system.libcurl, detail: redactDiagnosticText(system.libcurl.detail) },
    legacyOpenSsl: { ...system.legacyOpenSsl, detail: redactDiagnosticText(system.legacyOpenSsl.detail) },
    portwarpBinary: { ...system.portwarpBinary, detail: redactDiagnosticText(system.portwarpBinary.detail) },
    localtonetBinary: { ...system.localtonetBinary, detail: redactDiagnosticText(system.localtonetBinary.detail) },
    playitBinary: { ...system.playitBinary, detail: redactDiagnosticText(system.playitBinary.detail) },
    playitCliBinary: { ...system.playitCliBinary, detail: redactDiagnosticText(system.playitCliBinary.detail) },
    bedrockBinary: { ...system.bedrockBinary, detail: redactDiagnosticText(system.bedrockBinary.detail) },
    warnings: system.warnings.map(redactDiagnosticText),
  };
}

export function sanitizedLogLines(lines: readonly ConsoleLog[]): ConsoleLog[] {
  return lines
    .filter((line) => line.tag !== 'CONSOLE' && !/chat|message received|\bplayer\b|\bxuid\b|gamertag|joined the game|left the game/i.test(line.message))
    .slice(-120)
    .map((line) => ({ ...line, message: redactDiagnosticText(line.message) }));
}

export function sanitizedSamples(samples: readonly MonitoringSample[]): MonitoringSample[] {
  return samples.slice(-240).map((sample) => ({ ...sample }));
}

export function sanitizedAlerts(alerts: readonly OperationAlert[]): OperationAlert[] {
  return alerts.map((alert) => ({ ...alert, detail: redactDiagnosticText(alert.detail) }));
}
