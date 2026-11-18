// Состояние раскладки: выдвижные панели (<900px) и список участников по кнопке (900–1280px).
import { create } from 'zustand';

type Drawer = 'none' | 'channels' | 'members';
export const useLayout = create<{ drawer: Drawer; membersOpen: boolean; open(d: Drawer): void; toggleMembers(): void }>((set) => ({
  drawer: 'none',
  membersOpen: false,
  open: (drawer) => set({ drawer }),
  toggleMembers: () => set((s) => (window.innerWidth < 900 ? { drawer: s.drawer === 'members' ? 'none' : 'members' } : { membersOpen: !s.membersOpen })),
}));
