import { Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'
import path from 'path'
import { decodeEmergencyNumbers, SAFETYHUB_CONFIG_PACKAGE } from '../blobs/emergency-numbers'
import { fetchPhenotypeFlags, phenotypeTextproto, preparePhenotypeRequest } from '../blobs/phenotype'
import { ADEVTOOL_DIR } from '../config/paths'
import { AppRegistration } from '../proto-ts/vendor/adevtool/assets/heterodyne'
import { useStderrForLogs } from '../util/log'

export default class FetchEmergencyNumbers extends Command {
  static description = 'Fetch the SafetyHub country preference table and save it under emergency-numbers.'

  static flags = {
    device: Flags.string({ char: 'd', required: true, description: 'one Device config path or name' }),
    buildId: Flags.string({ char: 'b', description: 'factory image build ID (default: current device build)' }),
    output: Flags.string({ char: 'o', description: 'override the table output path, or save the request preview' }),
    dryRun: Flags.boolean({ default: false, description: 'print the generated request without contacting Phenotype' }),
  }

  async run() {
    let { flags } = await this.parse(FetchEmergencyNumbers)
    if (flags.dryRun) {
      useStderrForLogs()
    }
    let app = AppRegistration.fromPartial({
      configPackage: {
        name: SAFETYHUB_CONFIG_PACKAGE,
        version: '100918614',
        identity: { value: -1 },
        baselineCl: '991493647',
        variant: 'com.google.android.apps.safetyhub',
      },
      heterodyneInfo: Buffer.from('12170a1508f3e1d2bbedc0e5c3d2012208343537353133353118012001', 'hex'),
    })
    let { request } = await preparePhenotypeRequest(flags.device, flags.buildId, app)
    if (flags.dryRun) {
      let textproto = await phenotypeTextproto('decode', 'GetExperimentsAndConfigsRequest', request)
      if (flags.output !== undefined) {
        await fs.writeFile(flags.output, textproto)
      } else {
        process.stdout.write(textproto)
      }
      return
    }
    let numbers = await decodeEmergencyNumbers(await fetchPhenotypeFlags(request))
    let output =
      flags.output ?? path.join(ADEVTOOL_DIR, 'emergency-numbers', 'safetyhub-emergency-number-preferences.textproto')
    await fs.mkdir(path.dirname(output), { recursive: true })
    let temporary = `${output}.tmp`
    await fs.writeFile(temporary, numbers)
    await fs.rename(temporary, output)
    this.log(`Emergency number preferences written to ${output}`)
  }
}
