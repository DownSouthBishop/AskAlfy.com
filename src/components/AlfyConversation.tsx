import { useEffect, useState } from 'react';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';

type Step = 'user' | 'reply' | 'approval' | 'handover';

const steps: Step[] = ['user', 'reply', 'approval', 'handover'];

type ApprovalChoice = null | 'sent' | 'edit' | 'skip';
type HandoverChoice = null | 'yes' | 'notyet';

export default function AlfyConversation() {
	const [visible, setVisible] = useState(0);
	const [approval, setApproval] = useState<ApprovalChoice>(null);
	const [handover, setHandover] = useState<HandoverChoice>(null);

	useEffect(() => {
		if (visible >= steps.length) return;
		const delay = visible === 0 ? 500 : 900;
		const t = setTimeout(() => setVisible((v) => v + 1), delay);
		return () => clearTimeout(t);
	}, [visible]);

	const show = (step: Step) => visible >= steps.indexOf(step) + 1;

	return (
		<MotionConfig reducedMotion="user">
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
									type="button"
									onClick={() => setApproval('sent')}
									disabled={approval !== null}
									className="min-h-11 flex-1 cursor-pointer rounded-full bg-marigold px-4 text-small font-medium text-on-marigold transition-colors hover:bg-[#C97923] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso disabled:cursor-default disabled:opacity-60"
								>
									{approval === 'sent' ? 'Sent' : 'Send'}
								</button>
								<button
									type="button"
									onClick={() => setApproval('edit')}
									disabled={approval !== null}
									className="min-h-11 flex-1 cursor-pointer rounded-full border border-hairline px-4 text-small font-medium text-espresso transition-colors hover:bg-linen focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso disabled:cursor-default disabled:opacity-60"
								>
									{approval === 'edit' ? 'Draft open' : 'Edit'}
								</button>
								<button
									type="button"
									onClick={() => setApproval('skip')}
									disabled={approval !== null}
									className="min-h-11 flex-1 cursor-pointer rounded-full px-4 text-small font-medium text-secondary transition-colors hover:bg-linen focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso disabled:cursor-default disabled:opacity-60"
								>
									{approval === 'skip' ? 'Skipped' : 'Skip'}
								</button>
							</div>
							{approval === 'edit' && (
								<p className="text-small text-secondary">
									The draft opens right in the thread — change a word, then send.
								</p>
							)}
							{approval === 'skip' && (
								<p className="text-small text-secondary">
									Dropped. Alfy won't bring it up again.
								</p>
							)}
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
								<button
									type="button"
									onClick={() => setHandover('yes')}
									disabled={handover !== null}
									className="min-h-11 cursor-pointer rounded-full bg-fern px-4 text-small font-medium text-on-fern transition-colors hover:bg-[#436B59] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fern disabled:cursor-default disabled:opacity-60"
								>
									{handover === 'yes' ? 'Handled from now on' : 'Yes, handle it'}
								</button>
								<button
									type="button"
									onClick={() => setHandover('notyet')}
									disabled={handover !== null}
									className="min-h-11 cursor-pointer rounded-full px-4 text-small font-medium text-secondary transition-colors hover:bg-fern-tint focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fern disabled:cursor-default disabled:opacity-60"
								>
									Not yet
								</button>
							</div>
							{handover === 'yes' && (
								<p className="text-small font-medium text-fern">
									Done. You can take this back any time — just say so.
								</p>
							)}
							{handover === 'notyet' && (
								<p className="text-small text-secondary">
									No problem. Alfy will keep asking, every time.
								</p>
							)}
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		</MotionConfig>
	);
}
