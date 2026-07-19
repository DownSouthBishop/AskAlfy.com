import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

type Step = 'user' | 'reply' | 'approval' | 'handover';

const steps: Step[] = ['user', 'reply', 'approval', 'handover'];

export default function AlfyConversation() {
	const [visible, setVisible] = useState(0);
	const [approvalDone, setApprovalDone] = useState(false);

	useEffect(() => {
		if (visible >= steps.length) return;
		const delay = visible === 0 ? 500 : 900;
		const t = setTimeout(() => setVisible((v) => v + 1), delay);
		return () => clearTimeout(t);
	}, [visible]);

	const show = (step: Step) => visible >= steps.indexOf(step) + 1;

	return (
		<div className="w-full max-w-sm rounded-3xl border border-hairline bg-card p-5 shadow-[0_8px_30px_-12px_rgba(46,42,36,0.18)] space-y-3">
			<AnimatePresence>
				{show('user') && (
					<motion.div
						key="user"
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.4 }}
						className="flex justify-end"
					>
						<p className="max-w-[85%] rounded-2xl rounded-br-sm bg-espresso px-4 py-2 text-body text-linen">
							What am I forgetting?
						</p>
					</motion.div>
				)}

				{show('reply') && (
					<motion.div
						key="reply"
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.4 }}
						className="flex justify-start"
					>
						<p className="max-w-[90%] rounded-2xl rounded-bl-sm border border-hairline bg-linen px-4 py-2 text-body text-espresso">
							Three things: Mom's birthday is Saturday and there's no gift yet,
							the dentist tomorrow at 9 still needs confirming, and the wifi
							bill's due Friday.
							<br />
							<span className="text-secondary">— A</span>
						</p>
					</motion.div>
				)}

				{show('approval') && (
					<motion.div
						key="approval"
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.4 }}
						className="rounded-2xl border border-hairline bg-linen p-4 space-y-3"
					>
						<p className="text-body text-espresso">
							I found a gift she'd like and drafted a card. Want me to order it?
						</p>
						<div className="flex gap-2">
							<button
								onClick={() => setApprovalDone(true)}
								disabled={approvalDone}
								className="flex-1 rounded-full bg-marigold px-4 py-2 text-small font-medium text-on-marigold disabled:opacity-60"
							>
								{approvalDone ? 'Sent' : 'Send'}
							</button>
							<button className="flex-1 rounded-full border border-hairline px-4 py-2 text-small font-medium text-espresso">
								Edit
							</button>
							<button className="flex-1 rounded-full px-4 py-2 text-small font-medium text-muted">
								Skip
							</button>
						</div>
					</motion.div>
				)}

				{show('handover') && (
					<motion.div
						key="handover"
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.4 }}
						className="rounded-2xl border border-fern/20 bg-fern-tint p-4 space-y-3"
					>
						<p className="text-body text-espresso">
							That's five you've approved without edits — want me to handle
							these from now on?
						</p>
						<div className="flex gap-2">
							<button className="rounded-full bg-fern px-4 py-2 text-small font-medium text-on-marigold">
								Yes, handle it
							</button>
							<button className="rounded-full px-4 py-2 text-small font-medium text-secondary">
								Not yet
							</button>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
