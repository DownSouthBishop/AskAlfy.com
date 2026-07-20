import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// Scroll-in fade that can never strand content invisible: the tween is created
// paused (nothing renders until play), so if the trigger never fires the
// elements simply stay at their natural, visible state.
export function reveal(
	targets: string,
	trigger: string,
	opts: { start?: string; stagger?: number } = {}
) {
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	const tween = gsap.fromTo(
		targets,
		{ opacity: 0, y: 16 },
		{
			opacity: 1,
			y: 0,
			stagger: opts.stagger ?? 0.08,
			duration: 0.5,
			ease: 'power2.out',
			paused: true,
			immediateRender: false,
			// release inline transforms so CSS hover lifts work afterwards
			onComplete: () => gsap.set(targets, { clearProps: 'transform' }),
		}
	);
	ScrollTrigger.create({
		trigger,
		start: opts.start ?? 'top 75%',
		once: true,
		onEnter: () => tween.play(),
	});
}

// Slow vertical drift: headings move a beat behind their section as it crosses
// the viewport. Position-driven; barely perceptible; the liner.app trick.
export function drift(targets: string) {
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	gsap.utils.toArray<HTMLElement>(targets).forEach((el) => {
		gsap.fromTo(
			el,
			{ y: 28 },
			{
				y: -28,
				ease: 'none',
				scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: 0.6 },
			}
		);
	});
}
