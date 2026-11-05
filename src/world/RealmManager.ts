/** Global Veil Shift state: boolean realm + smoothed blend used by shaders and collision. */
export class RealmManager {
  isUnseenRealm = false;
  /** 0 = Physical Waking Stone, 1 = Unseen Wraith World (smoothed). */
  uRealmBlend = 0;
  /** 0..1 progress of the stained-glass transition ripple; >=1 means idle. */
  flashT = 1;
  private listeners: Array<(unseen: boolean) => void> = [];

  toggle(): void { this.set(!this.isUnseenRealm); }

  set(unseen: boolean): void {
    if (unseen === this.isUnseenRealm) return;
    this.isUnseenRealm = unseen;
    this.flashT = 0;
    for (const l of this.listeners) l(unseen);
  }

  reset(): void { this.isUnseenRealm = false; this.uRealmBlend = 0; this.flashT = 1; }

  onShift(cb: (unseen: boolean) => void): void { this.listeners.push(cb); }

  update(dt: number): void {
    const target = this.isUnseenRealm ? 1 : 0;
    this.uRealmBlend += (target - this.uRealmBlend) * (1 - Math.exp(-dt * 5));
    if (Math.abs(target - this.uRealmBlend) < 0.002) this.uRealmBlend = target;
    if (this.flashT < 1) this.flashT = Math.min(1, this.flashT + dt / 0.8);
  }
}

export const realm = new RealmManager();
