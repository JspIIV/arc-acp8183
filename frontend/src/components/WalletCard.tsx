import { useAccount, useReadContract, useSwitchChain } from 'wagmi'
import { erc20Abi } from 'viem'
import { ExternalLink, TriangleAlert } from 'lucide-react'
import { USDC_ADDRESS, ARC_CHAIN_ID } from '../config'
import { formatUsdc, shortAddr } from '../utils'
import { addressUrl } from '../contracts'

export default function WalletCard() {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()

  const { data: raw } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address },
  })

  const balance = raw as bigint | undefined
  const onArc   = chainId === ARC_CHAIN_ID

  return (
    <div
      className="rounded-2xl px-5 py-4 flex items-center justify-between gap-4"
      style={{
        background: 'rgba(172,198,233,0.06)',
        border: '1px solid rgba(172,198,233,0.2)',
      }}
    >
      {/* Left: address */}
      <a
        href={address ? addressUrl(address) : '#'}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 hover:opacity-80 transition-opacity"
      >
        <div
          className="w-8 h-8 rounded-full shrink-0"
          style={{
            background: 'linear-gradient(135deg, rgba(172,198,233,0.3), rgba(16,97,166,0.5))',
            border: '1px solid rgba(172,198,233,0.3)',
          }}
        />
        <span className="mono text-sm" style={{ color: 'var(--ink-2)' }}>
          {address ? shortAddr(address) : '—'}
        </span>
        <ExternalLink className="w-3 h-3 shrink-0" style={{ color: 'var(--subtle)' }} />
      </a>

      {/* Right: balance or wrong chain */}
      {!onArc ? (
        <button
          onClick={() => switchChain({ chainId: ARC_CHAIN_ID })}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-opacity hover:opacity-80"
          style={{ background: 'rgba(232,109,122,0.15)', color: 'var(--danger)', border: '1px solid rgba(232,109,122,0.3)' }}
        >
          <TriangleAlert className="w-3.5 h-3.5" />
          Switch to Arc
        </button>
      ) : (
        <div className="text-right">
          <p
            className="display text-xl font-bold tabular-nums leading-tight"
            style={{ color: 'var(--ink)' }}
          >
            {balance !== undefined ? formatUsdc(balance) : '—'}
          </p>
          <p className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: 'var(--accent)', letterSpacing: '0.08em' }}>
            USDC
          </p>
        </div>
      )}
    </div>
  )
}
