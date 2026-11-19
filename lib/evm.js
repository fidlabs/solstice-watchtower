// Decoders for the two contracts (SRA, SWA): events, message call data, revert errors.
// Every signature below is copied from solstice main at 87fd57c (2026-09-16); the file it comes from
// is named above each group so a signature can be checked against the Solidity source.
// Solidity's Epoch is uint64 and FixedU18 is uint256 (src/lib/Epoch.sol:4, src/lib/FixedU18.sol:4).
import { parseAbi, decodeEventLog, decodeFunctionData, decodeErrorResult } from 'viem'

export const abi = parseAbi([
  // src/lib/FVMRewardTypes.sol, src/lib/GateParams.sol, src/lib/SraTypes.sol
  'struct WeightRecord { int256 vStart; int256 slope; uint64 tStart; int256 floor; int256 cap; }',
  'struct WeightRecordUpdate { uint64 id; WeightRecord record; }',
  'struct Share { address wallet; uint256 share; }',
  'struct VolumeTarget { uint256 base; uint256 stepRatio; }',
  'struct GateParams { VolumeTarget target; uint64 steps; }',
  'struct Binding { address payer; address operator; }',
  'struct Reassignment { address payer; address operator; address orch; bool inherit; }',
  'struct FilecoinPayVolume { uint256 usd; }',

  // src/lib/UnanimousGovernance.sol, src/lib/Owners.sol, src/lib/UnanimousProxied.sol (shared by SRA and SWA).
  // OwnerAdded/OwnerRemoved are library events: forge leaves them out of the contract ABI, so they are listed by hand.
  'event Submitted(bytes32 indexed taskId)',
  'event Approved(bytes32 indexed taskId, address indexed owner)',
  'event Rejected(bytes32 indexed taskId, address indexed owner)',
  'event OwnerAdded(address indexed owner)',
  'event OwnerRemoved(address indexed owner)',
  'event OwnerReplaced(address indexed prevOwner, address indexed newOwner)',
  'event Upgraded(address indexed implementation)',
  'event Initialized(uint64 version)', // OpenZeppelin Initializable; seen in the calibnet deployment message, 2026-09-18
  'error HoldUntil(uint64 until)',
  'error AlreadyApproved()',
  'error TaskNotFound(bytes32 taskId)',
  'error AlreadyOwner(address owner)',
  'error MaximumOwnersReached()',
  'error NotOwner(address account)',
  'error CannotRemoveLastOwner()',
  'error NonzeroCallValue()',
  'function replaceOwner(address prevOwner, address newOwner)',
  'function veto(bytes32 taskId)',
  'function upgradeToAndCall(address newImplementation, bytes data) payable',

  // src/StreamWeightActor.sol
  'event QuarterlyGateCheckResult(uint64 indexed quarter, bool passed, uint64 steps)',
  // solstice PR #79 (merged 2026-09-22, in the calibnet v1 deploy 0006edc): emitted when setWeightRecords queues, and when setGateParams takes effect
  'event WeightRecordsQueued(WeightRecordUpdate[] updates)',
  'event GateParamsSet(GateParams params)',
  'error StepsComplete()',
  'error StepsOutOfRange()',
  // src/lib/GateParams.sol at 0fa8cca (PR #67): the gate check is blocked while one of these is outstanding
  'error PendingWeightWrite(uint64 until)',
  'error PendingGateParams(bytes32 taskId)',
  'function registerStream(uint64 id, WeightRecord record, uint64 activationEpoch)',
  'function registerStream(uint64 id, WeightRecord record, address writer, Share[] shares, uint64 activationEpoch)',
  'function removeStream(uint64 id)',
  'function setWeightRecords(WeightRecordUpdate[] updates)',
  'function setDistribution(uint64 id, address writer)',
  'function cancelPending(uint64 id, uint8 op)',
  'function cancelPendingWeight(uint8 op)',
  'function quarterlyGateCheck()',
  'function setGateParams(GateParams params)',

  // src/lib/FVMRewards.sol: an f02 call that f02 rejected; exitCode is f02's exit code.
  'error RegisterStreamFailed(int256 exitCode)',
  'error RemoveStreamFailed(int256 exitCode)',
  'error SetWeightRecordsFailed(int256 exitCode)',
  'error StepWeightRecordsFailed(int256 exitCode)',
  'error SetDistributionFailed(int256 exitCode)',
  'error CancelPendingFailed(int256 exitCode)',
  'error SetSharesFailed(int256 exitCode)',
  'error ReplaceAddressFailed(int256 exitCode)',
  'error ClaimFailed(int256 exitCode)',
  'error ValueOutOfRange(int256 value)',

  // src/ServiceRewardsActor.sol
  'event OrchestratorAdmitted(address indexed orch, address wallet)',
  'event OrchestratorRemoved(address indexed orch)',
  'event OrchestratorWalletReplaced(address indexed oldOrch, address indexed newWallet)',
  'event BindingDeclared(address indexed payer, address indexed operator, address indexed orchestrator)',
  'event BindingReassigned(address indexed payer, address indexed operator, address indexed orchestrator, bool inherit)',
  'event BindingCanceled(address indexed payer, address indexed operator, address indexed orchestrator)',
  'event AdmittedListsUpdated(address[] stablecoins, address[] filecoinPayContracts)',
  'event PricingParamsUpdated(uint256 minLotFloor, uint256 minLotAlphaNum, uint256 minLotAlphaDen, uint256 priceBand, uint256 registrationCutoff)',
  'event VolumePosted(uint64 indexed q, address indexed orchestrator, uint256 volume)',
  'event VolumeCorrected(uint64 indexed q, address indexed orchestrator, uint256 volume)',
  'event SharesSubmitted(uint64 indexed q, uint256 recipientCount, uint256 totalUsd)',
  'error NotAdmitted(address orch)',
  'error AlreadyAdmitted(address orch)',
  'error AtCapacity()',
  'error AlreadyBound(bytes32 pairId)',
  'error PairNotBound(bytes32 pairId)',
  'error NotInPostingWindow(uint64 q)',
  'error NotInVerificationWindow(uint64 q)',
  'error NotBound(uint64 q)',
  'error InvalidQuarter(uint64 q)',
  'error AlreadyPosted(uint64 q)',
  'error PendingShares(uint64 q)',
  // solstice PR #78 (2026-09-22, closes #61): a payout wallet must resolve to an existing actor
  'error InvalidActorId(uint64 actorId)',
  'error AlreadySubmitted(uint64 q)',
  'error NotLatestQuarter(uint64 q)',
  'error TooManyPairs()',
  'error ZeroWallet()',
  'error DuplicateWallet(address wallet)',
  'error InvalidParameter()',
  'function registerPairs(Binding[] pairs)',
  'function cancelBinding(address payer, address operator)',
  'function postVolume(uint64 q, uint256 fpv)',
  'function addOrchestrator(address orch, address wallet)',
  'function removeOrchestrator(address orch)',
  'function replaceWallet(address oldOrch, address newWallet)',
  'function reassignBinding(address payer, address operator, address orch, bool inherit)',
  'function reassignBindings(Reassignment[] rs)',
  'function setAdmittedLists(address[] stablecoins, address[] filecoinPayContracts)',
  'function setPricingParams(uint256 minLotFloor, uint256 minLotAlphaNum, uint256 minLotAlphaDen, uint256 priceBand, uint256 registrationCutoff)',
  'function correctVolume(address orch, uint64 q, uint256 value)',
  'function submitShares(uint64 q)',
  'function aggregatedFilecoinPayVolume(uint64 q) view returns (uint256 usd)',
  'function quarterStart(uint64 q) view returns (uint64)',
  'function isAdmitted(address orch) view returns (bool)',
  'function admittedCount() view returns (uint64)',
  'function orchestratorCount() view returns (uint64)',
  'function fpvOf(uint64 q, address orch) view returns ((uint256 usd) fpv)', // FilecoinPayVolume struct; a quarter with no live slot reads 0
  'function bindingOf(address payer, address operator) view returns (address orchestrator)',

  // A Safe multisig wraps the real call: the message goes to the Safe, the call to the SRA or SWA is inside `data`.
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 indexed txHash, uint256 payment)',
])

// JSON cannot hold BigInt: numbers become decimal strings, structs stay objects.
export const plain = (v) =>
  typeof v === 'bigint'
    ? v.toString()
    : Array.isArray(v)
      ? v.map(plain)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
        : v

// Each decoder returns { name, fields }. What the ABI does not know comes back as unknown(<selector>) with no fields,
// so the record still keeps the raw data.
export function decodeLog(log) {
  try {
    const d = decodeEventLog({ abi, data: log.data, topics: log.topics })
    return { name: d.eventName, fields: plain(d.args ?? {}) }
  } catch {
    return { name: `unknown(${log.topics[0]?.slice(0, 10)})`, fields: {} }
  }
}

export function decodeCall(input) {
  try {
    const d = decodeFunctionData({ abi, data: input })
    // a Safe message: report the call inside it, and where that call goes
    if (d.functionName === 'execTransaction')
      return { ...decodeCall(d.args[2]), innerTo: d.args[0].toLowerCase(), innerValue: d.args[1], innerData: d.args[2] }
    const names = argNames(d.functionName, d.args?.length ?? 0)
    return { name: d.functionName, fields: plain(Object.fromEntries((d.args ?? []).map((a, i) => [names[i] ?? i, a]))) }
  } catch {
    return { name: `unknown(${input.slice(0, 10)})`, fields: {} }
  }
}

export function decodeRevert(data) {
  if (!data || data === '0x') return 'reverted (no reason given)'
  try {
    const d = decodeErrorResult({ abi, data })
    return `${d.errorName}(${(d.args ?? []).map((a) => plain(a)).join(', ')})`
  } catch {
    return `unknown error ${data}` // the whole revert data, so it can be decoded later with the right ABI
  }
}

// registerStream has two forms, so the argument names are looked up by name and argument count.
function argNames(functionName, count) {
  const f = abi.find((x) => x.type === 'function' && x.name === functionName && x.inputs.length === count)
  return f ? f.inputs.map((i) => i.name) : []
}
