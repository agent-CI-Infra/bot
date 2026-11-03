import { create } from 'zustand'

/** Time windows the gate overview can aggregate over. */
export const WINDOW_OPTIONS = [
  { days: 1, labelKey: 'timeRange.24h' },
  { days: 7, labelKey: 'timeRange.7d' },
  { days: 30, labelKey: 'timeRange.30d' },
] as const

export const DEFAULT_WINDOW_DAYS = 7

type GateWindowState = {
  windowDays: number
  setWindowDays: (days: number) => void
}

/** Shared so every window control (page header, topbar) stays in sync. */
export const useGateWindow = create<GateWindowState>((set) => ({
  windowDays: DEFAULT_WINDOW_DAYS,
  setWindowDays: (days) => set({ windowDays: days }),
}))
