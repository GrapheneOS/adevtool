import { Command, Flags } from '@oclif/core'
import { promises as fs } from 'fs'
import { fetchPhenotypeFlags, getPhenotypeFlag, phenotypeTextproto, preparePhenotypeRequest } from '../blobs/phenotype'
import { extractPhenotypeRegistration } from '../blobs/phenotype-apk'
import { AppRegistration, Flag } from '../proto-ts/vendor/adevtool/assets/heterodyne'
import { useStderrForLogs } from '../util/log'

export default class FetchPhenotypeFlags extends Command {
  static description =
    'Fetch Phenotype flags using device metadata from a factory image and optional APK registration metadata. ' +
    'Requests default to English/US and omit Google account context, app parameters and runtime properties; ' +
    'flags may differ from those received by the installed app.'

  static flags = {
    device: Flags.string({ char: 'd', required: true, description: 'one Device config path or name' }),
    buildId: Flags.string({ char: 'b', description: 'factory image build ID (default: current device build)' }),
    apk: Flags.file({
      exists: true,
      description: 'app base APK providing registration metadata (default: namespace only)',
    }),
    namespace: Flags.string({
      required: true,
      description: 'exact configuration namespace, including #Android-package when applicable',
    }),
    flag: Flags.string({ description: 'output only this flag as a Flag textproto' }),
    language: Flags.string({ default: 'en', description: 'request language code, e.g. en or fr (not en-US)' }),
    country: Flags.string({ default: 'US', description: 'request country code, e.g. US or CH' }),
    output: Flags.string({ char: 'o', description: 'write response, flag or request preview textproto to this file' }),
    rawOut: Flags.string({ description: 'save the full raw response protobuf, regardless of --flag' }),
    dryRun: Flags.boolean({ default: false, description: 'print the generated request without contacting Phenotype' }),
  }

  async run() {
    let { flags } = await this.parse(FetchPhenotypeFlags)
    useStderrForLogs()
    if (flags.dryRun && flags.rawOut !== undefined) {
      throw new Error('--rawOut does not apply to --dryRun')
    }
    if (!flags.namespace) {
      throw new Error('A Phenotype namespace is required')
    }
    let app =
      flags.apk === undefined
        ? AppRegistration.fromPartial({ configPackage: { name: flags.namespace } })
        : await extractPhenotypeRegistration(flags.apk, flags.namespace)
    let { request } = await preparePhenotypeRequest(flags.device, flags.buildId, app, {
      language: flags.language,
      country: flags.country,
    })
    let textproto: Buffer
    if (flags.dryRun) {
      textproto = await phenotypeTextproto('decode', 'GetExperimentsAndConfigsRequest', request)
    } else {
      let response = await fetchPhenotypeFlags(request)
      if (flags.rawOut !== undefined) {
        await fs.writeFile(flags.rawOut, response)
      }
      if (flags.flag !== undefined) {
        let flag = getPhenotypeFlag(response, flags.namespace, flags.flag)
        textproto = await phenotypeTextproto('decode', 'Flag', Buffer.from(Flag.encode(flag).finish()))
      } else {
        textproto = await phenotypeTextproto('decode', 'GetExperimentsAndConfigsResponse', response)
      }
    }
    if (flags.output !== undefined) {
      await fs.writeFile(flags.output, textproto)
    } else {
      process.stdout.write(textproto)
    }
  }
}
