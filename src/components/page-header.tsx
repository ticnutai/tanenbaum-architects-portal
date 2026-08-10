export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border pb-6 text-right" dir="rtl">
      <div className="w-full">
        {eyebrow ? (
          <p className="mb-2 text-xs font-medium tracking-[0.2em] text-accent">{eyebrow}</p>
        ) : null}
        <h1 className="text-3xl font-bold">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="mt-5 flex flex-wrap justify-start gap-2">{actions}</div> : null}
    </div>
  );
}
