import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../fixtures'

test.use({ scenario: 'merchant' })

async function diagCount(label: string, loc: Locator): Promise<number> {
	try {
		const n = await loc.count()
		console.log(`DIAG ${label}: count = ${n}`)
		return n
	} catch (e) {
		console.log(`DIAG ${label}: ERROR ${String(e).slice(0, 200)}`)
		return -1
	}
}

async function diagTexts(label: string, loc: Locator): Promise<void> {
	try {
		const n = await loc.count()
		if (n === 0) {
			console.log(`DIAG ${label}: (not found)`)
			return
		}
		const texts = await loc.allTextContents()
		console.log(`DIAG ${label}: ${JSON.stringify(texts)}`)
	} catch (e) {
		console.log(`DIAG ${label}: ERROR ${String(e).slice(0, 200)}`)
	}
}

async function diagDisabled(label: string, loc: Locator): Promise<void> {
	try {
		const n = await loc.count()
		if (n === 0) {
			console.log(`DIAG ${label}: (not found)`)
			return
		}
		const disabled = await loc.first().isDisabled()
		const txt = await loc.first().innerText()
		console.log(`DIAG ${label}: disabled = ${disabled}, text = ${JSON.stringify(txt)}`)
	} catch (e) {
		console.log(`DIAG ${label}: ERROR ${String(e).slice(0, 200)}`)
	}
}

async function openCart(page: Page): Promise<Locator> {
	await page.getByRole('button').filter({ has: page.locator('.i-basket') }).click()
	const dialog = page.getByRole('dialog', { name: /your cart/i })
	await expect(dialog).toBeVisible({ timeout: 5_000 })
	return dialog
}

test.describe('DIAG: Shipping Selector (cart UI redesign)', () => {
	test('dump cart + checkout shipping DOM ground truth', async ({ buyerPage }) => {
		test.setTimeout(90_000)

		await buyerPage.goto('/products')

		const walletCard = buyerPage.locator('[data-testid="product-card"]').filter({ hasText: 'Bitcoin Hardware Wallet' })
		const tshirtCard = buyerPage.locator('[data-testid="product-card"]').filter({ hasText: 'Nostr T-Shirt' })
		await expect(walletCard).toBeVisible({ timeout: 20_000 })
		await expect(tshirtCard).toBeVisible({ timeout: 20_000 })

		await walletCard.getByRole('button', { name: /Add to Cart/i }).click()
		await expect(walletCard.getByRole('button', { name: /Add/i }).first()).toBeVisible()
		await tshirtCard.getByRole('button', { name: /Add to Cart/i }).click()
		await expect(tshirtCard.getByRole('button', { name: /Add/i }).first()).toBeVisible()

		const cartDialog = await openCart(buyerPage)
		await buyerPage.waitForTimeout(2000)

		console.log('========== DIAG CART DIALOG ==========')
		await diagCount('cart: "Select shipping method" trigger (should be 0)', buyerPage.getByText('Select shipping method'))
		await diagCount('cart: "Select shipping at checkout" exact (per-product)', buyerPage.getByText('Select shipping at checkout', { exact: true }))
		await diagCount('cart: "Select shipping at checkout" substring (incl. banner)', buyerPage.getByText('Select shipping at checkout'))
		await diagTexts('cart: yellow banner text', buyerPage.locator('.border-yellow-400').locator('p'))
		await diagDisabled('cart: Checkout button', cartDialog.getByRole('button', { name: /Checkout/i }))
		await diagCount('cart: select-trigger controls', cartDialog.locator('[data-slot="select-trigger"]'))
		try {
			const txt = await cartDialog.innerText()
			console.log(`DIAG cart: dialog innerText (first 1500 chars):\n${txt.slice(0, 1500)}`)
		} catch (e) {
			console.log(`DIAG cart innerText ERROR ${String(e).slice(0, 200)}`)
		}
		console.log('========== END CART ==========')

		const checkoutButton = cartDialog.getByRole('button', { name: /Checkout/i })
		await expect(checkoutButton).toBeEnabled({ timeout: 5_000 })
		await checkoutButton.click()

		await expect(buyerPage.getByText('Shipping Address', { exact: true })).toBeVisible({ timeout: 15_000 })
		await buyerPage.waitForTimeout(2500)

		console.log('========== DIAG CHECKOUT (shipping step) ==========')
		console.log(`DIAG checkout: url = ${buyerPage.url()}`)
		await diagCount('checkout: "Shipping Address" heading', buyerPage.getByText('Shipping Address', { exact: true }))
		await diagCount('checkout: "Select shipping method" sidebar triggers', buyerPage.getByText('Select shipping method'))
		await diagCount('checkout: "Select shipping method" within select-triggers', buyerPage.locator('[data-slot="select-trigger"]'))
		await diagTexts('checkout: sidebar yellow banner', buyerPage.locator('.border-yellow-400').locator('p'))
		await diagDisabled('checkout: submit button[form=shipping-form]', buyerPage.locator('button[form="shipping-form"]'))
		await diagCount('checkout: "Cart Summary" heading', buyerPage.getByText('Cart Summary'))
		console.log('========== END CHECKOUT ==========')

		console.log('========== DIAG SHIPPING OPTIONS ==========')
		const firstTrigger = buyerPage.getByText('Select shipping method').first()
		let opened = false
		try {
			await firstTrigger.click({ timeout: 5_000 })
			opened = true
		} catch (e) {
			console.log(`DIAG options: could not open first trigger: ${String(e).slice(0, 200)}`)
		}

		if (opened) {
			await buyerPage.waitForTimeout(700)
			const options = buyerPage.getByRole('option')
			await diagCount('options: role=option count', options)
			await diagTexts('options: names', options)

			const worldwide = buyerPage.getByRole('option', { name: /Worldwide Standard/ })
			try {
				await worldwide.click({ timeout: 5_000 })
				console.log('DIAG options: selected "Worldwide Standard"')
			} catch (e) {
				console.log(`DIAG options: could not select "Worldwide Standard": ${String(e).slice(0, 200)}`)
				await buyerPage.keyboard.press('Escape').catch(() => {})
			}
		}

		await buyerPage.waitForTimeout(1500)
		await diagDisabled('after-select-1: submit button', buyerPage.locator('button[form="shipping-form"]'))
		await diagCount('after-select-1: "Select shipping method" remaining', buyerPage.getByText('Select shipping method'))

		const secondTrigger = buyerPage.getByText('Select shipping method').first()
		try {
			await secondTrigger.click({ timeout: 5_000 })
			await buyerPage.waitForTimeout(500)
			const digital = buyerPage.getByRole('option', { name: /Digital Delivery/i })
			await digital.click({ timeout: 5_000 })
			console.log('DIAG options: selected "Digital Delivery" for second product')
		} catch (e) {
			console.log(`DIAG options: second selection failed: ${String(e).slice(0, 200)}`)
			await buyerPage.keyboard.press('Escape').catch(() => {})
		}

		await buyerPage.waitForTimeout(1500)
		await diagDisabled('after-select-2: submit button', buyerPage.locator('button[form="shipping-form"]'))
		await diagCount('after-select-2: "Select shipping method" remaining', buyerPage.getByText('Select shipping method'))
		await diagTexts('after-select-2: shipping cost lines', buyerPage.getByText(/Shipping:/i))
		console.log('========== END OPTIONS ==========')

		expect(buyerPage.url()).toContain('/checkout')
	})
})
