import path from 'path'
import { ADEVTOOL_DIR, getHostBinPath } from '../config/paths'
import { EmergencyNumberPreferences } from '../proto-ts/vendor/adevtool/assets/emergency_number_preferences'
import { spawnAsync2 } from '../util/process'
import { getPhenotypeBytesFlag } from './phenotype'

export const SAFETYHUB_CONFIG_PACKAGE = 'com.google.android.apps.safetyhub#com.google.android.apps.safetyhub'

export async function decodeEmergencyNumbers(response: Buffer): Promise<Buffer> {
  let payload = getPhenotypeBytesFlag(response, SAFETYHUB_CONFIG_PACKAGE, '45716898')
  let proto = path.join(ADEVTOOL_DIR, 'assets', 'emergency_number_preferences.proto')
  let table = EmergencyNumberPreferences.decode(payload)
  if (!table.entries.length) {
    throw new Error('SafetyHub returned an empty emergency number preference table')
  }
  for (let entry of table.entries) {
    if (!/^[A-Z]{2}$/.test(entry.countryIso ?? '') || !/^[0-9]+$/.test(entry.number ?? '')) {
      throw new Error('SafetyHub returned an invalid country or emergency number')
    }
  }
  return spawnAsync2({
    command: await getHostBinPath('aprotoc'),
    args: [`--proto_path=${path.dirname(proto)}`, '--decode=safetyhub.EmergencyNumberPreferences', proto],
    stdinData: payload,
  })
}
