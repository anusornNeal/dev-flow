import React from 'react';

interface TokenCredentialFieldProps {
  label: string;
  description?: string;
  tokenValue: string;
  tokenMasked: boolean;
  showToken: boolean;
  clearToken: boolean;
  placeholder: string;
  inputName: string;
  labelClassName?: string;
  onTokenChange: (value: string) => void;
  onShowTokenChange: (value: boolean) => void;
  onClearTokenChange: (value: boolean) => void;
}

export default function TokenCredentialField({
  label,
  description,
  tokenValue,
  tokenMasked,
  showToken,
  clearToken,
  placeholder,
  inputName,
  labelClassName = 'text-xs font-bold text-[#685547] dark:text-[#f3eadf]',
  onTokenChange,
  onShowTokenChange,
  onClearTokenChange,
}: TokenCredentialFieldProps) {
  const toggleEdit = () => {
    if (showToken) {
      onShowTokenChange(false);
      onTokenChange('');
      return;
    }

    onShowTokenChange(true);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className={labelClassName}>{label}</label>
        <div className="flex gap-2">
          {tokenMasked && !showToken && !clearToken && (
            <button
              onClick={() => onClearTokenChange(true)}
              className="text-[10px] text-red-500 font-bold hover:underline"
            >
              Remove
            </button>
          )}
          {!clearToken && (
            <button
              onClick={toggleEdit}
              className="text-[10px] text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d] font-bold hover:underline"
            >
              {showToken ? 'Cancel' : tokenMasked ? 'Replace' : 'Add'}
            </button>
          )}
        </div>
      </div>

      {description && (
        <p className="text-[11px] text-[#8a725f] dark:text-[#f3eadf] font-mono -mt-1">
          {description}
        </p>
      )}

      {showToken ? (
        <input
          type="password"
          name={inputName}
          autoComplete="new-password"
          value={tokenValue}
          onChange={event => onTokenChange(event.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[#ddd0ba] dark:border-[#584a3b] bg-white dark:bg-[#1e1914] text-[#3e3129] dark:text-[#f3eadf] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 dark:focus:ring-[#e0a070]/50 focus:border-[#d89745] dark:border-[#e0a070] dark:focus:border-[#e0a070] transition"
        />
      ) : clearToken ? (
        <div className="px-3 py-2 rounded-lg border border-[#fecaca] dark:border-[#584a3b] bg-[#fff0f0] dark:bg-[#1e1914] text-[11px] text-[#991b1b] dark:text-[#f3eadf] font-mono flex items-center justify-between">
          Pending removal (Save to apply)
          <button onClick={() => onClearTokenChange(false)} className="underline hover:text-[#7f1d1d] dark:text-[#f3eadf] dark:hover:text-[#f3eadf] font-bold">Undo</button>
        </div>
      ) : (
        <div className="px-3 py-2 rounded-lg border border-[#e5d4bb] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#1e1914] text-[11px] text-[#b89b82] dark:text-[#d6b56d] font-mono">
          {tokenMasked ? 'Token securely stored.' : `No ${label.replace(' Access Token', '')} token stored.`}
        </div>
      )}
    </div>
  );
}
