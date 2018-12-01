const { Keypair, Asset, Operation, Server, Network, TransactionBuilder } = require('stellar-sdk')
const btoa = require('btoa')

const BaseFee = 0.00001
const BaseReserve = 0.5
const EscrowMarginReserve = 0.5

const calBaseReserve = (margin, trustLine, offers = 1, signers = 1, entries = 0) => {
  return (2 + trustLine + offers + signers + entries) * BaseReserve + margin
}

const serverUrl = 'https://horizon-testnet.stellar.org'
const server = new Server(serverUrl)
Network.useTestNetwork()

const fundAccount = async () => {
  const account = Keypair.random()
  const result = await server.friendbot(account.publicKey()).call()
  return account
}

const issueAsset = async (code, amount) => {
  const assetKey = await fundAccount()
  const asset = new Asset(code, assetKey.publicKey())
  const distributorKey = Keypair.random()

  const account = await server.loadAccount(assetKey.publicKey())
  const txBuilder = new TransactionBuilder(account)

  const transaction = txBuilder.addOperation(Operation.createAccount({
    destination: distributorKey.publicKey(),
    startingBalance: '9900',
  }))
    .addOperation(Operation.changeTrust({
      asset,
      source: distributorKey.publicKey()
    }))
    .addOperation(paymentOperation(distributorKey, asset, amount))
    .build()

  transaction.sign(assetKey)
  transaction.sign(distributorKey)

  await server.submitTransaction(transaction)

  return { asset, distributorKey }
}

const payment = async (fromKey, toKey, asset, amount) => {
  return server.loadAccount(fromKey.publicKey())
    .then(account => {
      const txBuilder = new TransactionBuilder(account)
      txBuilder.addOperation(paymentOperation(toKey, asset, amount, fromKey))
      const transaction = txBuilder.build()
      transaction.sign(fromKey)

      return server.submitTransaction(transaction)
    })
}

const createAccount = async (parent, startingBalance, ...assets) => {
  const newKey = Keypair.random()
  return server.loadAccount(parent.publicKey())
    .then(async account => {
      const txBuilder = new TransactionBuilder(account)
      txBuilder.addOperation(Operation.createAccount({
        destination: newKey.publicKey(),
        startingBalance: `${startingBalance}`,
      }))

      assets.forEach(asset =>
        txBuilder.addOperation(
          Operation.changeTrust({
            asset,
            source: newKey.publicKey()
          })
        ))

      const transaction = txBuilder.build()
      transaction.sign(parent)
      transaction.sign(newKey)

      await server.submitTransaction(transaction)

      return newKey
    })
}

const createEscrow = async (parent, mto, srcAsset, amount, startingBalance, assets, signers) => {
  const newKey = Keypair.random()
  return server.loadAccount(parent.publicKey())
    .then(async account => {
      const txBuilder = new TransactionBuilder(account)
      const operations = []

      operations.push(
        Operation.createAccount({
          destination: newKey.publicKey(),
          startingBalance: `${startingBalance}`,
          source: mto.publicKey()
        }))

      assets.forEach(asset =>
        operations.push(
          Operation.changeTrust({ source: newKey.publicKey(), asset })
        ))

      signers.forEach(signer =>
        operations.push(
          Operation.setOptions({
            source: newKey.publicKey(),
            signer: {
              ed25519PublicKey: signer.publicKey(),
              weight: 1
            },
          })
        ))

      operations.push(
        Operation.setOptions({
          source: newKey.publicKey(),
          masterWeight: 0,
          lowThreshold: signers.length,
          medThreshold: signers.length,
          highThreshold: signers.length,
        }))

      operations.push(Operation.payment({
        asset: srcAsset,
        destination: newKey.publicKey(),
        amount: amount.toFixed(7),
        source: parent.publicKey()
      }))

      fees = BaseFee * (operations.length + 1)

      operations.p

      operations.forEach(operation => txBuilder.addOperation(operation))
      txBuilder.addOperation(Operation.payment({
        asset: Asset.native(),
        amount: fees.toFixed(7),
        destination: parent.publicKey(),
        source: mto.publicKey()
      }))

      const transaction = txBuilder.build()
      transaction.sign(parent)
      transaction.sign(mto)
      transaction.sign(newKey)
      // signers.forEach(singer => transaction.sign(singer))

      const xdr = btoa(transaction.toEnvelope().toXDR())
      console.log(`\n\n${xdr}\n\n`)

      const result = await server.submitTransaction(transaction)
      console.log(result.hash)
      return newKey
    })
}

const swapOperations = (fromKey, asset1, toKey, asset2, amount, unitPrice) => {
  return [
    Operation.manageOffer({
      selling: asset1,
      buying: asset2,
      amount: amount.toFixed(7),
      price: (1 / unitPrice).toFixed(15),
      source: fromKey.publicKey()
    }),
    Operation.manageOffer({
      selling: asset2,
      buying: asset1,
      amount: (amount / unitPrice).toFixed(7),
      price: unitPrice.toFixed(15),
      source: toKey.publicKey()
    })
  ]
}

const paymentOperation = (toKey, asset, amount, fromKey = null) => {
  const option = {
    destination: toKey.publicKey(),
    asset,
    amount: amount.toFixed(7)
  }
  fromKey && (option.source = fromKey.publicKey())

  return Operation.payment(option)
}

const createContract = async (escrowKey, mto1, mto2, toKey, asset1, asset2, sysAsset, conv1, conv2, amount) => {
  return server.loadAccount(escrowKey.publicKey())
    .then(account => {
      const txBuilder = new TransactionBuilder(account)

      swapOperations(escrowKey, asset1, mto1, sysAsset, amount, conv1)
        .forEach(transaction => txBuilder.addOperation(transaction))

      swapOperations(escrowKey, sysAsset, mto2, asset2, amount / conv1, conv2)
        .forEach(transaction => txBuilder.addOperation(transaction))

      txBuilder.addOperation(paymentOperation(toKey, asset2, amount / conv1 / conv2, escrowKey))

      account.balances.filter(balance => balance.asset_type !== 'native').forEach(balance => {
        txBuilder.addOperation(Operation.changeTrust({
          asset: new Asset(balance.asset_code, balance.asset_issuer),
          limit: '0',
          source: escrowKey.publicKey()
        }))
      })

      txBuilder.addOperation(Operation.accountMerge({
        destination: mto1.publicKey(),
        source: escrowKey.publicKey()
      }))

      return txBuilder.build()
    })
}

const start = async () => {
  const depAmount = 10000
  console.log('*** Issuing assets')
  let startTime = Date.now()
  const systemAsset = await issueAsset('OLEV', 1000 * 1000000)
  const vthbAsset = await issueAsset('VTHB', 1000 * 1000000)
  const vgbpAsset = await issueAsset('VGBP', 1000 * 1000000)

  console.log(systemAsset.asset.code, systemAsset.asset.issuer)
  console.log(vthbAsset.asset.code, vthbAsset.asset.issuer)
  console.log(vgbpAsset.asset.code, vgbpAsset.asset.issuer)
  console.log('*** Assets issued', Date.now() - startTime); startTime = Date.now()

  const god = await fundAccount()

  console.log('*** Creating MTO accounts')
  const mto1 = await createAccount(god, 500, vthbAsset.asset, systemAsset.asset)
  const mto2 = await createAccount(god, 500, vgbpAsset.asset, systemAsset.asset)

  console.log('mto1', mto1.publicKey())
  console.log('mto2', mto2.publicKey())

  await payment(vthbAsset.distributorKey, mto1, vthbAsset.asset, 100 * 1000000)
  await payment(vgbpAsset.distributorKey, mto2, vgbpAsset.asset, 100 * 1000000)
  await payment(systemAsset.distributorKey, mto1, systemAsset.asset, 100 * 1000000)
  await payment(systemAsset.distributorKey, mto2, systemAsset.asset, 100 * 1000000)

  console.log('*** MTO accounts created', Date.now() - startTime); startTime = Date.now()

  console.log('*** Creating Alice/Bob wallets')
  // create user account for Alice and Bob
  const alice = await createAccount(mto1, 2.5, vthbAsset.asset)
  const bob = await createAccount(mto2, 2.5, vgbpAsset.asset)

  console.log('alice', alice.publicKey(), alice.secret())
  console.log('bob', bob.publicKey(), bob.secret())
  console.log('*** Wallets created', Date.now() - startTime); startTime = Date.now()

  // alice make a deposite
  console.log('*** alice make a deposite')
  const result = await payment(mto1, alice, vthbAsset.asset, depAmount)
  console.log(result.hash)
  console.log('*** fund transfered', Date.now() - startTime); startTime = Date.now()

  const VTHB_OLEV = 1 / 0.1
  const OLEV_VGBP = 0.1 / 120

  // create an escrow account between alice & bob
  console.log('*** Creating an escrow account Bob/Alice')
  const escrow = await createEscrow(
    alice,
    mto1,
    vthbAsset.asset,
    depAmount,
    calBaseReserve(EscrowMarginReserve, 3, 1, 4, 0),
    [systemAsset.asset, vthbAsset.asset, vgbpAsset.asset],
    [mto1, mto2, alice, bob]
  )

  console.log('escrow', escrow.publicKey())
  console.log('*** Escrow created', Date.now() - startTime); startTime = Date.now()

  // create a fund transfer contract
  console.log('*** Creating a contract between Alice - Bob')
  const contract = await createContract(escrow, mto1, mto2, bob, vthbAsset.asset, vgbpAsset.asset, systemAsset.asset, VTHB_OLEV, OLEV_VGBP, depAmount)

  console.log('*** Contract created', Date.now() - startTime); startTime = Date.now()

  console.log('*** Signing contract')
  // Source, mto1
  // Alice sign contract
  contract.sign(alice)
  // mto1 sign contract
  contract.sign(mto1)

  // counter party, mto2
  // bob sign contract
  contract.sign(bob)
  // mto2 sign contract
  contract.sign(mto2)
  console.log('*** Contract signed', Date.now() - startTime); startTime = Date.now()

  return contract.toEnvelope().toXDR()
}

start().then(xdr => {
  console.log('\n\nsubmit this contract via horizon')
  console.log(`\n\n${btoa(xdr)}\n\n`)
})
  .catch(err => {
    console.error(err.toString())
  })