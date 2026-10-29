import { Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'
import path from 'path'
import { decodeEmergencyNumbers, SAFETYHUB_CONFIG_PACKAGE } from '../blobs/emergency-numbers'
import { fetchPhenotypeFlags, parsePhenotypeApp, phenotypeTextproto, preparePhenotypeRequest } from '../blobs/phenotype'
import { extractPhenotypeRegistration } from '../blobs/phenotype-apk'
import { ADEVTOOL_DIR } from '../config/paths'
import { AppRegistration } from '../proto-ts/vendor/adevtool/assets/heterodyne'
import { useStderrForLogs } from '../util/log'

const REGISTRATION_FILE = path.join(ADEVTOOL_DIR, 'emergency-numbers', 'safetyhub.textproto')

export default class FetchEmergencyNumbers extends Command {
  static description = 'Fetch the SafetyHub country preference table and generate the SettingsLib Java class.'

  static flags = {
    device: Flags.string({ char: 'd', required: true, description: 'one Device config path or name' }),
    buildId: Flags.string({ char: 'b', description: 'factory image build ID (default: current device build)' }),
    output: Flags.string({ char: 'o', description: 'override the table output path, or save the request preview' }),
    dryRun: Flags.boolean({ default: false, description: 'print the generated request without contacting Phenotype' }),
    'update-registration': Flags.file({
      exists: true,
      description: 'update the saved registration from a SafetyHub base APK before fetching flags',
    }),
  }

  async run() {
    let { flags } = await this.parse(FetchEmergencyNumbers)
    if (flags.dryRun) {
      useStderrForLogs()
    }
    let apkPath = flags['update-registration']
    let app: AppRegistration
    if (apkPath !== undefined) {
      app = await extractPhenotypeRegistration(apkPath, SAFETYHUB_CONFIG_PACKAGE)
      if (app.configPackage?.variant !== 'com.google.android.apps.safetyhub') {
        throw new Error(
          `${apkPath}: expected com.google.android.apps.safetyhub, received ${app.configPackage?.variant}`,
        )
      }
    } else {
      app = await parsePhenotypeApp(await fs.readFile(REGISTRATION_FILE), SAFETYHUB_CONFIG_PACKAGE)
    }
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
    if (apkPath !== undefined) {
      let textproto = await phenotypeTextproto(
        'decode',
        'AppRegistration',
        Buffer.from(AppRegistration.encode(app).finish()),
      )
      let comment = '# Update: adevtool fetch-emergency-numbers -d DEVICE --update-registration path/to/base.apk\n'
      await fs.writeFile(`${REGISTRATION_FILE}.tmp`, comment + textproto.toString())
      await fs.rename(`${REGISTRATION_FILE}.tmp`, REGISTRATION_FILE)
      this.log(`SafetyHub registration written to ${REGISTRATION_FILE}`)
    }
    let numbers = await decodeEmergencyNumbers(await fetchPhenotypeFlags(request))
    let output = path.resolve(
      flags.output ?? path.join(ADEVTOOL_DIR, 'emergency-numbers', 'safetyhub-emergency-number-preferences.textproto'),
    )
    let javaOutput = path.join(path.dirname(output), 'EmergencyNumberPreferences.java')
    if (output === javaOutput || output === `${javaOutput}.tmp`) {
      throw new Error('The textproto output path conflicts with the generated Java output')
    }
    await fs.mkdir(path.dirname(output), { recursive: true })
    let files = [
      [output, numbers.textproto],
      [javaOutput, numbers.javaSource],
    ] as const
    for (let [file, contents] of files) {
      await fs.writeFile(`${file}.tmp`, contents)
    }
    for (let [file] of files) {
      await fs.rename(`${file}.tmp`, file)
    }
    this.log(`Emergency number preferences written to ${output}`)
    this.log(`SettingsLib preferences written to ${javaOutput}`)
  }
}
