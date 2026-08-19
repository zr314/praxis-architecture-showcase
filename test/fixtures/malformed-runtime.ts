process.stdout.write('this is not JSON\n')
setTimeout(() => process.exit(1), 10).unref()
