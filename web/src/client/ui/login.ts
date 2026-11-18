import { defaultDomain, defaultServerUrl, type Account, type ServerConfig } from '../config';
import { h } from './dom';
import { icon } from './icons';

export interface LoginResult {
  account: Account;
  remember: boolean;
}

/** Sign-in screen. `onSubmit` resolves when registered or rejects with a message to show. */
export class LoginView {
  readonly el: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly error: HTMLElement;
  private readonly submit: HTMLButtonElement;

  constructor(
    config: ServerConfig,
    initial: Partial<Account> & { remember?: boolean },
    private readonly onSubmit: (result: LoginResult) => Promise<void>,
  ) {
    const extension = h('input', {
      id: 'login-extension',
      name: 'username',
      class: 'input',
      autocomplete: 'username',
      inputmode: 'numeric',
      placeholder: 'e.g. 1001',
      required: true,
      list: 'login-directory',
      value: initial.extension ?? '',
    });
    const directory = h(
      'datalist',
      { id: 'login-directory' },
      ...config.directory.filter((u) => u.type === 'webrtc').map((u) => h('option', { value: u.extension }, u.name)),
    );
    const password = h('input', {
      id: 'login-password',
      name: 'password',
      class: 'input',
      type: 'password',
      autocomplete: 'current-password',
      required: true,
      value: initial.password ?? '',
    });
    const reveal = h(
      'button',
      {
        type: 'button',
        class: 'input-addon',
        'aria-label': 'Show password',
        onclick: () => {
          const show = password.type === 'password';
          password.type = show ? 'text' : 'password';
          reveal.replaceChildren(icon(show ? 'eye-off' : 'eye', 18));
          reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        },
      },
      icon('eye', 18),
    );
    const displayName = h('input', {
      id: 'login-name',
      name: 'displayName',
      class: 'input',
      autocomplete: 'name',
      placeholder: 'Optional — defaults to the directory name',
      value: initial.displayName ?? '',
    });
    const server = h('input', {
      id: 'login-server',
      name: 'server',
      class: 'input mono',
      required: true,
      spellcheck: 'false',
      value: initial.server || defaultServerUrl(config),
    });
    const domain = h('input', {
      id: 'login-domain',
      name: 'domain',
      class: 'input mono',
      required: true,
      spellcheck: 'false',
      value: initial.domain || defaultDomain(config),
    });
    const remember = h('input', { id: 'login-remember', type: 'checkbox', checked: initial.remember ?? true });

    this.error = h('div', { class: 'form-error', role: 'alert', hidden: true });
    this.submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in');

    this.form = h(
      'form',
      { class: 'login-form', novalidate: true },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Extension'), extension, directory),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Password'), h('div', { class: 'input-group' }, password, reveal)),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Display name'), displayName),
      h(
        'details',
        { class: 'advanced' },
        h('summary', {}, 'Server settings'),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'SIP WebSocket URL'), server),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'SIP domain'), domain),
      ),
      h('label', { class: 'checkbox' }, remember, h('span', {}, 'Keep me signed in on this device')),
      this.error,
      this.submit,
    );

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const ext = extension.value.trim();
      if (!/^[0-9]{2,10}$/.test(ext)) return this.showError('Enter your extension number (digits only).');
      if (!password.value) return this.showError('Enter your password.');
      if (!/^wss?:\/\//i.test(server.value.trim())) return this.showError('The server URL must start with wss:// or ws://');
      const fallbackName = config.directory.find((u) => u.extension === ext)?.name ?? '';
      void this.run({
        account: {
          extension: ext,
          password: password.value,
          displayName: displayName.value.trim() || fallbackName,
          server: server.value.trim(),
          domain: domain.value.trim() || defaultDomain(config),
        },
        remember: remember.checked,
      });
    });

    this.el = h(
      'main',
      { class: 'login-screen' },
      h(
        'section',
        { class: 'login-card', 'aria-labelledby': 'login-title' },
        h('div', { class: 'brand brand-lg' }, h('div', { class: 'brand-mark' }, icon('logo', 26)), h('div', {}, h('h1', { id: 'login-title' }, 'Asterisk Phone'), h('p', { class: 'muted' }, 'Secure HD voice & video calling'))),
        this.form,
      ),
      h('p', { class: 'login-footer muted' }, 'Asterisk 22 · PJSIP · WebRTC (DTLS-SRTP)'),
    );

    queueMicrotask(() => (extension.value ? password : extension).focus());
  }

  showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
  }

  private async run(result: LoginResult): Promise<void> {
    this.error.hidden = true;
    this.submit.disabled = true;
    this.submit.replaceChildren(h('span', { class: 'spinner' }), 'Connecting…');
    try {
      await this.onSubmit(result);
    } catch (error) {
      this.showError((error as Error).message);
    } finally {
      this.submit.disabled = false;
      this.submit.replaceChildren('Sign in');
    }
  }
}
