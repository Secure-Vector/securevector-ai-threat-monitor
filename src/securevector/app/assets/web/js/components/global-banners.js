/**
 * Global banners, retired in 5.3.0.
 *
 * The slot above page content used to carry a Guardian ML disclosure, an
 * enrollment pointer and a release what's-new banner. Product decision:
 * no top banners. Guardian ML is disclosed in Settings and on the welcome
 * screen; enrollment lands the user on Cloud Activity directly.
 *
 * The object stays because the welcome screen and the Optimizer spotlight
 * still ack KEY_WHATS_NEW and call render(); render() now only removes any
 * slot an older build left in the DOM.
 */

const GlobalBanners = {
    WHATS_NEW_VERSION: '5.2.0',
    KEY_WHATS_NEW: 'sv-whats-new-acked',
    KEY_GUARDIAN_NOTICE: 'sv-guardian-notice-acked',
    KEY_ENROLLED: 'sv-enrolled-banner-acked',

    async render() {
        const slot = document.getElementById('sv-global-banners');
        if (slot) slot.remove();
    },
};

window.GlobalBanners = GlobalBanners;
