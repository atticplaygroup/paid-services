import { createClient } from "../../examples/realworld/client.ts"
import { createAuthenticatedFetch } from "../../applications/client-auth/src/lib.ts"
import { BrowserCashierAccessTokenProvider, Cashier, parseCashierConfig } from "../../applications/cashier/src/lib.ts"
import { generateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
const rawWallet = {accounts:[{principal:"fresh-browser",masterSecretMnemonic:generateMnemonic(wordlist),payments:[{mnemonic:generateMnemonic(wordlist),paymentEnvironment:2,autoFaucet:true,suiFaucetUrl:"http://localhost:3001"}]}],defaultChainDepositAmount:"2000000000",defaultProviderDepositAmount:"500000000",accountOriginOverrides:{"sql.localhost":"http://sql.localhost:18183","localhost":"http://localhost:18182","index.localhost":"http://index.localhost:18184","objects.localhost":"http://objects.localhost:18185"},manifestOriginOverrides:{"sql.localhost":"http://localhost:3001","index.localhost":"http://localhost:3001","objects.localhost":"http://localhost:3001"}}
const wallet = parseCashierConfig(JSON.stringify(rawWallet))
const cashier = new Cashier(wallet)
;(globalThis as any).probe = async () => {
 const before = await cashier.getChainBalance({preferredPaymentCoin:1,preferredPaymentEnvironment:2},"fresh-browser")
 if(before.balance !== "0") throw new Error("fresh wallet must be empty")
 const provider = new BrowserCashierAccessTokenProvider(wallet,"fresh-browser",wallet.accounts[0].payments[0])
 const paid = createAuthenticatedFetch(provider)
 const balance = async () => {
   const response = await paid("http://sql.localhost:18183/account.v1.AccountService/GetBalance", {method:"POST",headers:{"content-type":"application/json"},body:"{}"})
   if (!response.ok) throw new Error(`Balance ${response.status}: ${await response.text()}`)
   return BigInt((await response.json()).balance ?? "0")
 }
 const creditBefore = await balance()
 const response = await paid("http://sql.localhost:18183/sql",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sql:"SELECT 1 AS paid",parameters:[]})})
 if(!response.ok) throw new Error(`SQL ${response.status}: ${await response.text()}`)
 const sql = await response.json()
 const deadline = Date.now() + 30000
 let creditAfter = await balance()
 while (creditAfter >= creditBefore && Date.now() < deadline) {
   await new Promise(resolve => setTimeout(resolve, 200))
   creditAfter = await balance()
 }
 const config = await (await fetch("/config.json")).json()
 const client = createClient(config, provider)
 const articles = await client.api("/api/articles?limit=1")
 const image = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1WQAAAAASUVORK5CYII="), c=>c.charCodeAt(0))
 const cid = await client.upload(image, 60)
 const url = await client.media(cid)
 const element = new Image()
 element.src = url
 await element.decode()
 const mediaRendered = url.startsWith("blob:") && element.naturalWidth === 1
 URL.revokeObjectURL(url)
 ;(globalThis as any).PAID_CONFIG = config
 ;(globalThis as any).PAID_CASHIER_CONFIG = JSON.stringify(rawWallet)
 const html = await (await fetch("/ui.html")).text()
 document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML
 return {articlesRead:Array.isArray(articles.articles),mediaRendered,cid,before:before.balance,sql,creditBefore:creditBefore.toString(),creditAfter:creditAfter.toString()}
}
