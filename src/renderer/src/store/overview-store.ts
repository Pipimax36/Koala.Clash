import { create } from 'zustand'

// The overview and persistent status bar must describe the same strategy group.
export const useOverviewStore = create<{
  groupName: string
  selectGroup: (groupName: string) => void
}>((set) => ({ groupName: '', selectGroup: (groupName) => set({ groupName }) }))
