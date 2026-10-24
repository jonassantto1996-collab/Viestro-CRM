'use client';
import {useState, type InputHTMLAttributes} from 'react';
import {Eye, EyeOff} from 'lucide-react';

// Campo de senha com botão "mostrar/ocultar".
export default function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [show, setShow] = useState(false);
  return (
    <span className="password-input">
      <input {...props} type={show ? 'text' : 'password'} />
      <button
        type="button"
        onClick={() => setShow(v => !v)}
        aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
        aria-pressed={show}
        title={show ? 'Ocultar senha' : 'Mostrar senha'}
      >
        {show ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </span>
  );
}
