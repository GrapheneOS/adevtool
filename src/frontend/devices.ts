import chalk from 'chalk'

export async function forEachDevice<Device>(
  devices: Device[],
  parallel: boolean,
  callback: (device: Device) => Promise<void>,
  deviceKey: (device: Device) => string = d => d as string,
) {
  let jobs = []
  for (let device of devices) {
    let job = callback(device)
    if (parallel) {
      jobs.push(job)
    } else {
      if (devices.length > 1) {
        console.log(`${chalk.bold(chalk.blueBright(deviceKey(device)))}`)
      }
      await job
    }
  }

  if (parallel && devices.length >= 2) {
    console.log('Devices: ' + devices.map(d => deviceKey(d)).join(' | '))
  }

  await Promise.all(jobs)
}
